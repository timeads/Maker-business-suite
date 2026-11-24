"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Check, Plus, Printer, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import {
  MAX_BOXES,
  formatPrice,
  formatTenthOz,
  tenthOzToLbOz,
  type AddressCheck,
  type Signature,
} from "@/lib/shipping/easypost";
import { deliveryDays, parseInches, type ShipToEdit } from "@/lib/shipping/labels";
import { listService } from "@/lib/shipping/list";
import {
  carrierMark,
  poundsToTenthOz,
  sameService,
  tenthOzToPounds,
} from "@/lib/shipping/order-page";
import {
  contentsTenthOz as boxContentsTenthOz,
  emptyAlloc,
  fullAlloc,
  notInBox,
  setQty,
  splitEvenly,
  unitsIn,
  weightsKnown,
  withoutBox,
  type Alloc,
} from "@/lib/shipping/packing";
import { pickService } from "@/lib/shipping/rules";
import type { SourceRateChoice } from "@/lib/shipping/sources/rates";
import {
  SOURCE_CHIPS,
  SOURCE_NAMES,
  SOURCE_PAID_FROM,
  type LabelSourceKey,
} from "@/lib/shipping/sources/types";
import { printSettings, wantedLabelFormat } from "@/lib/shipping/zebra/settings";
import { MARK_TONES } from "./carrier-mark";
import { buyLabel, checkLabelAddress, getLabelRates, type RatesInput } from "./label-actions";
import { saveOrderChoice } from "./plan-actions";
import { PrintsToZebraNote } from "./print-ui";

/** An item in the order, as the bench needs it for dividing between boxes. */
export type DeskLine = {
  id: string;
  title: string;
  /** "Large · RUG-L" */
  detail: string;
  qty: number;
  /** One unit's weight in tenths of an ounce, when the shop gave one. */
  tenthOz: number | null;
  photo: string | null;
};

export type DeskBox = {
  id: string;
  name: string;
  /** "12 × 9 × 4 in" */
  size: string;
  /** The box's own weight, in tenths of an ounce. */
  emptyTenthOz: number;
  /** Inches, as text for the size boxes. */
  length: string;
  width: string;
  height: string;
};

const CUSTOM = "";

/** What an order opens with: its plan, as the bench lays it out. */
export type DeskStart = {
  /** Every box, in order. Empty when the workspace has no box to start from. */
  boxes: {
    /** A saved box's id, or empty for a size of its own. */
    boxId: string;
    length: string;
    width: string;
    height: string;
    /** Packed, in tenths of an ounce, when it is known. */
    tenthOz: number | null;
    /** A weight from the scale (typed, or remembered), not one worked out from the shop's figures. */
    weighed: boolean;
    /** How many of each item are in it. */
    alloc: Alloc;
  }[];
  /** Why these boxes: a saved choice, a rule, memory, or simply the usual box. */
  source: "default" | "person" | "rule" | "learned" | "learned-similar" | "saved";
  signature: Signature;
  /** Said under the signature select: "Rule: Signature on orders of $250.00 or more". */
  signatureNote: string | null;
  /** "cheapest", "fastest" or a service's name, when a rule or a saved choice asks for one. */
  service: string | null;
  serviceFrom: "rule" | "saved" | null;
  /** Every rule that did something for this order. */
  rules: string[];
  /** What a person saved for the signature and the service; null where they left it to the plan. */
  savedSignature: Signature | null;
  savedService: string | null;
};

/** One box on the bench: which saved box (or none), its size and what it weighs packed. */
type Packed = {
  /** Stays with the box while others come and go, for React and the field ids. */
  key: number;
  boxId: string;
  size: { length: string; width: string; height: string };
  /** Pounds, as shown in the one weight box ("12.6"). */
  weight: string;
  /** The weight worked out from the shop's figures, to the tenth of an ounce; null once typed over. */
  exact: number | null;
  /** The weight was typed by hand, so picking another box leaves it alone. */
  weightTyped: boolean;
  /** How many of each item are in this box. */
  alloc: Alloc;
};

/** A weight we worked out: shown rounded, kept exact so the label is quoted on the real figure. */
const worked = (tenths: number | null): Pick<Packed, "weight" | "exact"> => ({
  weight: tenths === null ? "" : tenthOzToPounds(tenths),
  exact: tenths,
});

/** One box's weight in tenths of an ounce: what was typed, else what was worked out. */
const tenthsOf = (box: Pick<Packed, "weight" | "exact" | "weightTyped">): number | null =>
  box.weightTyped || box.exact === null ? poundsToTenthOz(box.weight) : box.exact;

/** The weight as the server takes it: pounds and ounces that mean exactly the same. */
const sentWeight = (tenths: number | null) =>
  tenths === null ? { lb: "", oz: "" } : tenthOzToLbOz(tenths);

/** What all the boxes weigh together, in tenths of an ounce; null while any isn't a number. */
function totalTenthOz(packed: Packed[]): number | null {
  let total = 0;
  for (const box of packed) {
    const tenths = tenthsOf(box);
    if (tenths === null) return null;
    total += tenths;
  }
  return total;
}

type Checked =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "edited" }
  | { state: "done"; check: AddressCheck }
  | { state: "failed"; message: string }
  /** No connected account checks addresses. */
  | { state: "skipped" };

/**
 * Address checks already made while this page has been open, so going back to
 * an order doesn't ask the carriers again. Held in memory only: a reload
 * starts afresh, and nothing is written anywhere.
 */
const addressChecks = new Map<string, AddressCheck>();
const addressKey = (orderId: string, address: ShipToEdit) =>
  `${orderId}|${JSON.stringify([
    address.recipient,
    address.company,
    address.address1,
    address.address2,
    address.city,
    address.region,
    address.postal_code,
  ])}`;

/** The small tag saying where a label would be bought. */
function SourceChip({ source }: { source: LabelSourceKey }) {
  return (
    <span className="bg-sunken text-text-2 inline-flex h-[21px] items-center rounded-full px-2 text-xs font-semibold whitespace-nowrap">
      {SOURCE_CHIPS[source]}
    </span>
  );
}

/** "Paid from your UPS account", or every connected account when no service is chosen yet. */
function paidFrom(chosen: LabelSourceKey | null, connected: LabelSourceKey[]) {
  const from = chosen ? [chosen] : connected;
  if (from.length === 0) return "";
  const words = from.map((key) => SOURCE_PAID_FROM[key]);
  return chosen || words.length === 1
    ? `Postage is paid from ${words[0]}.`
    : `Postage is paid from the account you choose: ${words.map((word) => word.replace(/^your /, "")).join(", ")}.`;
}

const SIGNATURE_WORDS: Record<Signature, string> = {
  none: "No signature",
  signature: "Signature required",
  adult: "Adult signature required",
};

// Name | Company | Phone, then Address (wide) | Apt, then City (widest) | State | ZIP | Country.
const FIELDS: { key: keyof ShipToEdit; label: string; span: string; max: number }[] = [
  { key: "recipient", label: "Name", span: "col-span-2 sm:col-span-4", max: 120 },
  { key: "company", label: "Company", span: "sm:col-span-4", max: 120 },
  { key: "phone", label: "Phone", span: "sm:col-span-4", max: 30 },
  { key: "address1", label: "Address", span: "col-span-2 sm:col-span-8", max: 120 },
  { key: "address2", label: "Apt / suite", span: "col-span-2 sm:col-span-4", max: 120 },
  { key: "city", label: "City", span: "col-span-2 sm:col-span-5", max: 120 },
  { key: "region", label: "State", span: "sm:col-span-2", max: 60 },
  { key: "postal_code", label: "ZIP", span: "sm:col-span-3", max: 20 },
];

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** "$9.42" and whether the label costs more than the shopper paid. */
function leftOver(paidCents: number | null, price: string, currency: string) {
  const cost = Math.round(Number(price) * 100);
  if (paidCents === null || !Number.isFinite(cost)) return null;
  const left = paidCents - cost;
  return { short: left < 0, amount: formatPrice((Math.abs(left) / 100).toFixed(2), currency) };
}

/**
 * Everything for buying one label, laid out the way it's worked through:
 * what it will cost and the Buy button on top, then where it's going, what
 * it's packed in, and the services on offer. Changes to the address stay on
 * this label; the order itself is never altered.
 */
export function LabelDesk({
  slug,
  orderId,
  withIds,
  shipTo,
  country,
  boxes,
  start,
  resets,
  contentsTenthOz,
  paid,
  shop,
  sources,
  testSources,
  setup,
  lines,
  itemCount,
  toTitle = "Ship to",
  record = null,
  recordOpen = false,
  off = null,
  children,
}: {
  slug: string;
  orderId: string;
  /** Other orders going in this parcel; one label covers them all. */
  withIds?: string[];
  shipTo: ShipToEdit;
  country: string;
  /** The usual box first. */
  boxes: DeskBox[];
  /**
   * What the order opens with: what a person saved for it, else a rule's box,
   * the packing remembered for these items, or the usual box.
   */
  start: DeskStart;
  /**
   * Where "Reset" goes back to. `plan`: the plan without what a person saved
   * for this order. `usual`: the usual box, offered when memory decided.
   * Left out for several orders in one parcel, where nothing is saved.
   */
  resets?: { plan?: DeskStart; usual?: DeskStart };
  /** What the shop says the items weigh, in tenths of an ounce. */
  contentsTenthOz: number | null;
  /** What the shopper paid for shipping and the option they picked. */
  paid: {
    cents: number | null;
    words: string;
    /** "$33.00", when the amount is known, for "Margin = $33.00 paid − label". */
    amount: string | null;
    method: string | null;
  };
  shop: { offered: boolean; markSent: boolean; notify: boolean };
  /** The connected places to buy postage: every one is asked for its prices. */
  sources: LabelSourceKey[];
  /** Those of them whose labels are practice ones, not real postage. */
  testSources: LabelSourceKey[];
  /** What's still missing before a carrier will quote, with where to fix it. */
  setup: { missing: string; href: string | null } | null;
  /** The items going in this purchase, for dividing between several boxes. */
  lines: DeskLine[];
  /** How many things were ordered, for the card's title. */
  itemCount: number;
  toTitle?: string;
  /** The form for recording a parcel by hand (part shipments, postage bought elsewhere). */
  record?: React.ReactNode;
  /** That form starts open: it's the way to send this order. */
  recordOpen?: boolean;
  /**
   * No label can be bought here right now (nothing connected, a pickup, already
   * sent…). The page keeps its shape: the same cards, read only, with a plain
   * word on why. Nothing is asked of a carrier.
   */
  off?: {
    /** Said where the Buy button would be; null leaves that card out. */
    bar: React.ReactNode;
    /** Said in the Service card; null leaves that card out. */
    service: React.ReactNode;
    /** Whether the boxes are shown (read only) with the items. */
    boxes: boolean;
    /** A warning about the address, where there is one. */
    addressNote?: string | null;
  } | null;
  /** The items in the order, shown under the box. */
  children: React.ReactNode;
}) {
  const startTenths = (box: DeskBox | undefined) =>
    contentsTenthOz === null ? null : contentsTenthOz + (box?.emptyTenthOz ?? 0);
  const startWeight = (box: DeskBox | undefined) => worked(startTenths(box));
  const [to, setTo] = useState(shipTo);
  const [checked, setChecked] = useState<Checked>({ state: "idle" });
  const [residential, setResidential] = useState(true);
  const [signature, setSignature] = useState<Signature>(start.signature);
  const sizeOf = (box: DeskBox | undefined) => ({
    length: box?.length ?? "",
    width: box?.width ?? "",
    height: box?.height ?? "",
  });
  // The order starts as its plan has it: the boxes a person saved, a rule's box, the packing
  // remembered for these items, or the usual box at the weight the shop gave.
  const laidOut = (from: DeskStart): Packed[] =>
    from.boxes.length > 0
      ? from.boxes.map((box, index) => ({
          key: index,
          boxId: boxes.some((saved) => saved.id === box.boxId) ? box.boxId : CUSTOM,
          size: { length: box.length, width: box.width, height: box.height },
          ...(box.weighed && box.tenthOz !== null
            ? { weight: tenthOzToPounds(box.tenthOz), exact: null }
            : worked(box.tenthOz)),
          weightTyped: box.weighed && box.tenthOz !== null,
          alloc: { ...box.alloc },
        }))
      : [
          {
            key: 0,
            boxId: CUSTOM,
            size: sizeOf(undefined),
            ...startWeight(undefined),
            weightTyped: false,
            alloc: fullAlloc(lines),
          },
        ];
  const [packed, setPacked] = useState<Packed[]>(() => laidOut(start));
  /** The service a rule or a saved choice asks for; a person picking another replaces it. */
  const [policy, setPolicy] = useState<{ service: string | null; from: DeskStart["serviceFrom"] }>({
    service: start.service,
    from: start.serviceFrom,
  });
  const policyNow = useRef(policy.service);
  /** Whose set-up is on the bench: the plan's, or one a person saved for this order. */
  const [mode, setMode] = useState<"plan" | "saved">(
    start.source === "saved" || start.source === "person" ? "saved" : "plan",
  );
  /** What a person has decided about the signature and the service here; null leaves it to the plan. */
  const chose = useRef<{ signature: Signature | null; service: string | null }>({
    signature: start.savedSignature,
    service: start.savedService,
  });
  /** Counts a person's own changes to boxes, weights, split, signature or service: each is saved. */
  const [edits, setEdits] = useState(0);
  const canSave = !off && !withIds?.length;
  const touched = () => {
    if (!canSave) return;
    setMode("saved");
    setEdits((count) => count + 1);
  };
  // With a weight for every item, each box's weight follows what's put in it.
  const known = weightsKnown(lines);
  const reweigh = (list: Packed[]): Packed[] =>
    list.length > 1 && known
      ? list.map((box) =>
          box.weightTyped
            ? box
            : {
                ...box,
                ...worked(
                  (boxes.find((saved) => saved.id === box.boxId)?.emptyTenthOz ?? 0) +
                    boxContentsTenthOz(box.alloc, lines),
                ),
              },
        )
      : list;
  const nextKey = useRef(Math.max(1, start.boxes.length));
  const [rates, setRates] = useState<SourceRateChoice[] | null>(null);
  /** A word on each connected account that couldn't be asked this time. */
  const [notes, setNotes] = useState<string[]>([]);
  /** Exactly what the rates on screen were asked with: buying sends the same again. */
  const [asked, setAsked] = useState<RatesInput | null>(null);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [markSent, setMarkSent] = useState(shop.offered && shop.markSent);
  const [notify, setNotify] = useState(shop.notify);
  /** Money was spent (or may have been): never offer Buy again on this screen. */
  const [locked, setLocked] = useState(false);
  const [recording, setRecording] = useState(recordOpen);
  const recordRef = useRef<HTMLDivElement>(null);
  const [quoting, startQuote] = useTransition();
  const [buying, startBuy] = useTransition();
  const sent = useRef(false);
  const opened = useRef(false);
  /** Counts what has been asked and changed, so a late answer to an old question is dropped. */
  const asking = useRef(0);
  /** How many times the details have changed since the page opened. */
  const [changes, setChanges] = useState(0);

  // A price belongs to one address and one set of boxes and weights: change any and it's gone.
  const stale = () => {
    // Anything still on its way back was asked with the old details: it is ignored.
    asking.current += 1;
    setChanges((count) => count + 1);
    setRates(null);
    setNotes([]);
    setAsked(null);
    setChosen("");
    setError(null);
  };

  // One steady list, so asking for rates doesn't start over on every render.
  const withKey = (withIds ?? []).join(",");
  const together = useMemo(() => (withKey ? withKey.split(",") : undefined), [withKey]);
  type Ask = { to: ShipToEdit; residential: boolean; signature: Signature };
  const quote = useCallback(
    (ask: Ask, parcels: (Pick<Packed, "boxId" | "size" | "alloc"> & { tenths: number | null })[]) =>
      startQuote(async () => {
        const mine = ++asking.current;
        setError(null);
        const input: RatesInput = {
          boxes: parcels.map((parcel) => {
            const weight = sentWeight(parcel.tenths);
            return {
              boxId: parcel.boxId,
              ...parcel.size,
              weightLb: weight.lb,
              weightOz: weight.oz,
              // Not for the carriers: only so the packing can be remembered afterwards.
              alloc: parcel.alloc,
            };
          }),
          shipTo: ask.to,
          residential: ask.residential,
          signature: ask.signature,
          withIds: together,
          // This computer's own choice: a Zebra is sent its own format, not a picture.
          labelFormat: wantedLabelFormat(printSettings()),
        };
        const result = await getLabelRates(slug, orderId, input);
        // The details changed while the carriers were answering: these prices are for something else.
        if (mine !== asking.current) return;
        if (result.error || !result.rates) {
          setRates(null);
          setNotes([]);
          setAsked(null);
          setError(result.error ?? "We couldn't get rates. Try again.");
          return;
        }
        setAsked(input);
        setNotes(result.notes ?? []);
        setRates(result.rates);
        // The service a rule or a saved choice asks for when it's offered, else the cheapest.
        setChosen(
          pickService(result.rates, policyNow.current)?.rate.id ?? result.rates[0]?.id ?? "",
        );
      }),
    [slug, orderId, together],
  );
  const quoteNow = () =>
    quote(
      { to, residential, signature },
      packed.map((box) => ({
        boxId: box.boxId,
        size: box.size,
        alloc: box.alloc,
        tenths: tenthsOf(box),
      })),
    );

  const check = useCallback(
    async (address: ShipToEdit, again = false): Promise<AddressCheck | null> => {
      const key = addressKey(orderId, address);
      const known = again ? undefined : addressChecks.get(key);
      if (known) {
        setChecked({ state: "done", check: known });
        if (known.residential !== null) setResidential(known.residential);
        return known;
      }
      setChecked({ state: "checking" });
      const result = await checkLabelAddress(slug, orderId, address);
      if (result.skipped) {
        setChecked({ state: "skipped" });
        return null;
      }
      if (!result.check) {
        setChecked({ state: "failed", message: result.error ?? "We couldn't check the address." });
        return null;
      }
      addressChecks.set(key, result.check);
      setChecked({ state: "done", check: result.check });
      if (result.check.residential !== null) setResidential(result.check.residential);
      return result.check;
    },
    [slug, orderId],
  );

  // On opening: check the address, then ask for prices if every box and its weight are
  // known, so the next order is ready to buy by the time it's on screen.
  useEffect(() => {
    if (opened.current || off) return;
    opened.current = true;
    void (async () => {
      const found = await check(shipTo);
      const opening = laidOut(start).map((box) => ({
        boxId: box.boxId,
        size: box.size,
        alloc: box.alloc,
        tenths: tenthsOf(box),
      }));
      const ready = opening.every(
        (box) =>
          box.tenths !== null &&
          box.tenths > 0 &&
          box.size.length &&
          box.size.width &&
          box.size.height,
      );
      if (setup || start.boxes.length === 0 || !ready) return;
      quote(
        { to: shipTo, residential: found?.residential ?? true, signature: start.signature },
        opening,
      );
    })();
    // Runs once for the order on screen; the page remounts this for the next one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typeAddress = (key: keyof ShipToEdit, value: string) => {
    setTo((before) => ({ ...before, [key]: value }));
    setChecked({ state: "edited" });
    stale();
  };
  const takeSuggestion = (suggestion: NonNullable<AddressCheck["suggestion"]>) => {
    const next = {
      ...to,
      address1: suggestion.street1,
      address2: suggestion.street2 ?? "",
      city: suggestion.city,
      region: suggestion.state ?? "",
      postal_code: suggestion.zip,
    };
    setTo(next);
    setChecked((before) =>
      before.state === "done"
        ? { state: "done", check: { ...before.check, suggestion: null } }
        : before,
    );
    stale();
  };
  const change = (key: number, edit: (box: Packed) => Packed) => {
    setPacked((before) => reweigh(before.map((box) => (box.key === key ? edit(box) : box))));
    stale();
    touched();
  };
  const repack = (edit: (allocs: Alloc[]) => Alloc[]) => {
    setPacked((before) => {
      const allocs = edit(before.map((box) => box.alloc));
      return reweigh(
        before.map((box, index) => ({
          ...box,
          alloc: allocs[index] ?? box.alloc,
          // What's inside changed, so a weight worked out from the contents is worked out again.
          weightTyped: known ? false : box.weightTyped,
        })),
      );
    });
    stale();
    touched();
  };
  const pickBox = (key: number, id: string) => {
    const saved = boxes.find((box) => box.id === id);
    change(key, (box) => ({
      ...box,
      boxId: id,
      size: id === CUSTOM ? box.size : sizeOf(saved),
      ...(box.weightTyped ? {} : startWeight(saved)),
    }));
  };
  const typeSize = (key: number, side: keyof Packed["size"], value: string) =>
    // A size typed by hand is its own box, not the saved one.
    change(key, (box) => ({ ...box, boxId: CUSTOM, size: { ...box.size, [side]: value } }));
  const typeWeight = (key: number, value: string) =>
    change(key, (box) => ({ ...box, weight: value, exact: null, weightTyped: true }));
  // Another box starts as a copy of the last one's size, waiting for its weight.
  const addBox = () => {
    const key = nextKey.current++;
    setPacked((before) => {
      if (before.length >= MAX_BOXES) return before;
      const last = before[before.length - 1];
      // The new box starts empty; the others keep what's in them until items are moved.
      return reweigh([
        ...before.map((box) => (known ? { ...box, weightTyped: false } : box)),
        {
          key,
          boxId: last.boxId,
          size: { ...last.size },
          weight: "",
          exact: null,
          weightTyped: !known,
          alloc: emptyAlloc(lines),
        },
      ]);
    });
    stale();
    touched();
  };
  const removeBox = (key: number) => {
    setPacked((before) => {
      const index = before.findIndex((box) => box.key === key);
      if (before.length <= 1 || index < 0) return before;
      // Its items go to the box before it.
      const allocs = withoutBox(
        before.map((box) => box.alloc),
        index,
      );
      const kept = before
        .filter((box) => box.key !== key)
        .map((box, at) => ({ ...box, alloc: allocs[at] }));
      if (kept.length === 1 && !kept[0].weightTyped) {
        const saved = boxes.find((item) => item.id === kept[0].boxId);
        return [{ ...kept[0], ...startWeight(saved) }];
      }
      return reweigh(kept);
    });
    stale();
    touched();
  };

  // What a person set up here is kept with the order as they go, so it can be bought later
  // from the packing computer or in a bulk run. Quiet: nothing on the page waits for it.
  const saveLatest = useRef<() => void>(() => {});
  useEffect(() => {
    saveLatest.current = () => {
      const kept = packed.map((box) => {
        const length = parseInches(box.size.length);
        const width = parseInches(box.size.width);
        const height = parseInches(box.size.height);
        const tenths = box.weightTyped ? tenthsOf(box) : null;
        return length && width && height
          ? {
              box_id: box.boxId || null,
              length,
              width,
              height,
              weight_tenth_oz: tenths !== null && tenths > 0 && tenths <= 24_000 ? tenths : null,
              items: box.alloc,
            }
          : null;
      });
      // A box still being typed isn't a set-up yet; the next change saves it.
      if (kept.some((box) => box === null)) return;
      void saveOrderChoice(slug, orderId, {
        v: 1,
        boxes: kept,
        signature: chose.current.signature,
        service: chose.current.service,
      }).catch(() => undefined);
    };
  });
  useEffect(() => {
    if (edits === 0) return;
    const timer = setTimeout(() => saveLatest.current(), 700);
    return () => clearTimeout(timer);
  }, [edits]);

  /** Back to a plan: the order's own (forgetting what was saved), or the usual box. */
  const resetTo = (target: DeskStart, forget: boolean) => {
    setPacked(laidOut(target));
    nextKey.current = Math.max(1, target.boxes.length);
    setSignature(target.signature);
    policyNow.current = target.service;
    setPolicy({ service: target.service, from: target.serviceFrom });
    stale();
    if (forget) {
      chose.current = { signature: null, service: null };
      setMode("plan");
      setEdits(0);
      void saveOrderChoice(slug, orderId, null).catch(() => undefined);
    } else {
      // Choosing the usual box over what was remembered is a choice, and is kept.
      touched();
    }
  };
  const pickRate = (item: SourceRateChoice) => {
    setChosen(item.id);
    if (!canSave) return;
    const name = listService(item.carrier, item.name);
    chose.current = { ...chose.current, service: name };
    policyNow.current = name;
    setPolicy({ service: name, from: "saved" });
    touched();
  };

  const rate = rates?.find((item) => item.id === chosen) ?? null;
  // The service a rule asked for, when a carrier offers it: marked in the list.
  const ruled =
    rates && start.serviceFrom === "rule" && policy.from === "rule"
      ? pickService(rates, start.service)
      : null;
  const ruleRateId = ruled?.matched ? ruled.rate.id : null;
  const busy = quoting || buying;

  // Prices follow the page: once a change settles (the weight, the box, the signature, or an
  // address that has been checked again), the carriers are asked again without a press.
  const busyNow = useRef(false);
  const quoteLatest = useRef<() => void>(() => {});
  useEffect(() => {
    busyNow.current = busy;
    quoteLatest.current = quoteNow;
  });
  const settled =
    !off &&
    !locked &&
    !setup &&
    rates === null &&
    checked.state !== "edited" &&
    checked.state !== "checking" &&
    packed.every((box) => {
      const tenths = tenthsOf(box);
      return tenths !== null && tenths > 0 && box.size.length && box.size.width && box.size.height;
    });
  useEffect(() => {
    if (changes === 0 || !settled) return;
    let timer: ReturnType<typeof setTimeout>;
    const ask = () => {
      // Still asking about the last change: wait for it, then ask about this one.
      if (busyNow.current) timer = setTimeout(ask, 400);
      else quoteLatest.current();
    };
    timer = setTimeout(ask, 900);
    return () => clearTimeout(timer);
    // Each change counts once; what is asked is read fresh when the wait is over.
  }, [changes, settled]);
  const canBuy = Boolean(rate) && !busy && !locked && !off;

  const buy = useCallback(() => {
    // One press, one purchase: the ref closes the gap before the button greys out.
    if (sent.current || locked || !chosen) return;
    if (packed.length > 1 && lines.length > 0) {
      const allocs = packed.map((box) => box.alloc);
      if (
        lines.some((line) => notInBox(allocs, line) !== 0) &&
        !window.confirm("Some items aren't in a box. Buy the labels anyway?")
      ) {
        return;
      }
      const empty = packed
        .map((box, index) => (unitsIn(box.alloc, lines) > 0 ? 0 : index + 1))
        .filter(Boolean);
      if (
        empty.length > 0 &&
        !window.confirm(
          `${empty.length === 1 ? `Box ${empty[0]} has` : `Boxes ${empty.join(", ")} have`} nothing in ${empty.length === 1 ? "it" : "them"}. Buy a label for ${empty.length === 1 ? "it" : "them"} anyway?`,
        )
      ) {
        return;
      }
    }
    sent.current = true;
    startBuy(async () => {
      setError(null);
      const result = await buyLabel(
        slug,
        orderId,
        chosen,
        { markSent, notify },
        together,
        asked ?? undefined,
      );
      // On success the page moves on to the finished label; there is no result.
      if (!result) return;
      if (result.bought) {
        setLocked(true);
        setRates(null);
      } else {
        sent.current = false;
      }
      setError(result.error ?? "Something went wrong. Reload this page before trying again.");
    });
  }, [slug, orderId, together, chosen, locked, markSent, notify, packed, lines, asked]);

  // Ctrl+P (or ⌘P) buys and prints, the way it does on the bench.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "p") return;
      if (!canBuy) return;
      event.preventDefault();
      buy();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [buy, canBuy]);

  const several = packed.length > 1;
  const first = packed[0];
  const picked = boxes.find((box) => box.id === first.boxId);
  const showBoxes = !off || off.boxes;
  // Without boxes on show, the weight is the items' own, as the shop gave it.
  const total = showBoxes ? totalTenthOz(packed) : contentsTenthOz;
  const margin = rate ? leftOver(paid.cents, rate.price, rate.currency) : null;
  // Said only where an account reports it, and only while it could be the one that's used.
  const testNote = off
    ? null
    : rate && testSources.includes(rate.source)
      ? sources.length > 1
        ? `Test mode: ${SOURCE_NAMES[rate.source]} labels are not real`
        : "Test mode: labels are not real"
      : !rate && testSources.length > 0
        ? testSources.length === sources.length && sources.length === 1
          ? "Test mode: labels are not real"
          : `Test mode: ${testSources.map((key) => SOURCE_NAMES[key]).join(" and ")} labels are not real`
        : null;
  const stat = "flex min-w-0 flex-col gap-0.5";
  const statLabel = "text-muted-foreground text-xs font-semibold whitespace-nowrap";
  const frozen = busy || locked || Boolean(off);
  const openRecord = () => {
    setRecording(true);
    // Once it's on the page, bring it into view.
    window.setTimeout(
      () => recordRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }),
      0,
    );
  };

  return (
    <>
      {(!off || off.bar) && (
        <Card>
          <CardContent className="flex flex-col gap-3 p-4 sm:px-5">
            {off ? (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                <p className="min-w-0 flex-1 basis-64 text-sm">{off.bar}</p>
                {record && !recording && (
                  <Button type="button" variant="outline" onClick={openRecord}>
                    Record a parcel by hand
                  </Button>
                )}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
                  {rate ? (
                    <>
                      <div className={stat}>
                        <span className={statLabel}>Service</span>
                        <span className="flex flex-wrap items-center gap-x-2 text-[15px] font-bold">
                          {rate.name}
                          <span className="text-muted-foreground font-medium">
                            · {SOURCE_NAMES[rate.source]}
                          </span>
                        </span>
                        <span className="text-muted-foreground text-xs">
                          {rate.days !== null
                            ? `Est. ${deliveryDays(rate.days)}`
                            : "Transit time varies"}
                        </span>
                      </div>
                      <div className={stat}>
                        <span className={statLabel}>
                          {several ? `${packed.length} labels` : "Label"}
                        </span>
                        <span className="text-[15px] font-bold tabular-nums">
                          {formatPrice(rate.price, rate.currency)}
                        </span>
                        <span className="text-xs" aria-hidden>
                          &nbsp;
                        </span>
                      </div>
                      <div className={stat}>
                        <span className={statLabel}>Customer paid</span>
                        <span className="text-[15px] font-bold tabular-nums">{paid.words}</span>
                        <span className="text-muted-foreground max-w-48 truncate text-xs">
                          {paid.method ?? " "}
                        </span>
                      </div>
                      {margin && (
                        <div className={stat}>
                          <span className={statLabel}>Margin</span>
                          <span
                            className={`text-[15px] font-bold tabular-nums ${margin.short ? "text-brick" : "text-mint-ink"}`}
                          >
                            {margin.short ? "−" : "+"}
                            {margin.amount}
                          </span>
                          <span className="text-xs" aria-hidden>
                            &nbsp;
                          </span>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="min-w-0 flex-1 basis-64 text-sm">
                      {locked
                        ? "This label is being sorted out. See the message below."
                        : quoting
                          ? "Asking the carriers what this would cost…"
                          : several
                            ? "Check the address and each box's size and weight, then get rates."
                            : "Check the address, box and weight, then get rates."}
                    </p>
                  )}
                  <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
                    {testNote && <Badge tone="waiting">{testNote}</Badge>}
                    {!locked &&
                      (rates ? (
                        <Button
                          type="button"
                          size="lg"
                          onClick={buy}
                          disabled={!canBuy}
                          className="w-full sm:w-auto"
                        >
                          <Printer aria-hidden />
                          {buying
                            ? several
                              ? "Buying your labels…"
                              : "Buying your label…"
                            : several
                              ? `Buy & print ${packed.length} labels`
                              : "Buy & print label"}
                          <kbd className="hidden rounded-sm border border-current/30 px-1 font-sans text-[10px] opacity-80 sm:inline">
                            Ctrl+P
                          </kbd>
                        </Button>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="lg"
                          onClick={quoteNow}
                          disabled={busy}
                          className="w-full sm:w-auto"
                        >
                          {quoting ? "Asking the carriers…" : "Get rates"}
                        </Button>
                      ))}
                  </div>
                </div>
                <div className="border-border flex flex-wrap items-center gap-x-6 gap-y-2 border-t pt-3 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={markSent}
                      disabled={!shop.offered || busy || locked}
                      onChange={(event) => setMarkSent(event.target.checked)}
                    />
                    {together
                      ? "Mark every one of these orders fulfilled in my shop"
                      : "Mark fulfilled in my shop"}
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={notify && markSent}
                      disabled={!markSent || busy || locked}
                      onChange={(event) => setNotify(event.target.checked)}
                    />
                    Email the customer their tracking
                  </label>
                  <span className="text-muted-foreground text-xs sm:ml-auto">
                    <PrintsToZebraNote fallback="Opens the 4×6 label to print" />
                  </span>
                  {!shop.offered && (
                    <span className="text-muted-foreground w-full text-xs">
                      Your shop hasn&apos;t given permission to mark orders as sent, so do that
                      there yourself.
                    </span>
                  )}
                </div>
              </>
            )}
            <FormMessage>{error}</FormMessage>
          </CardContent>
        </Card>
      )}

      {!off && setup && (
        <p className="bg-note border-note-border rounded-lg border px-4 py-2.5 text-sm">
          <span className="font-semibold">One thing before the carriers can quote:</span>{" "}
          {setup.missing}{" "}
          {setup.href ? (
            <a href={setup.href} className="text-ochre-text font-semibold hover:underline">
              Open Shipping settings
            </a>
          ) : (
            "Ask an owner or admin to add it in Shipping settings."
          )}
        </p>
      )}

      {!off && start.rules.length > 0 && (
        <p className="bg-note border-note-border flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm">
          <Sparkles className="text-ochre-text size-4 shrink-0" aria-hidden />
          <span>
            Rules applied:{" "}
            <span className="font-semibold">{start.rules.map(sentence).join(" · ")}</span>
            {mode === "saved" && (
              <span className="text-muted-foreground"> · your own choices here come first</span>
            )}
          </span>
        </p>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <CardTitle>{toTitle}</CardTitle>
            {!off && (
              <span className="text-muted-foreground text-xs">
                Changes apply to this label only
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {off ? (
            off.addressNote && (
              <p className="bg-brick-soft text-brick rounded-md px-3 py-2 text-sm">
                {off.addressNote}
              </p>
            )
          ) : (
            <AddressVerdict
              checked={checked}
              residential={residential}
              onCheck={() => void check(to, true)}
              onUse={takeSuggestion}
            />
          )}
          <fieldset
            disabled={frozen}
            className="grid grid-cols-2 gap-x-3 gap-y-2.5 sm:grid-cols-12"
          >
            {FIELDS.map((field) => (
              <div key={field.key} className={`flex min-w-0 flex-col gap-1.5 ${field.span}`}>
                <Label htmlFor={`to-${field.key}`}>{field.label}</Label>
                <Input
                  id={`to-${field.key}`}
                  value={to[field.key]}
                  maxLength={field.max}
                  onChange={(event) => typeAddress(field.key, event.target.value)}
                />
              </div>
            ))}
            <div className="flex min-w-0 flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="to-country">Country</Label>
              <Input id="to-country" value={country} readOnly disabled />
            </div>
          </fieldset>
          {showBoxes && (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <label className="flex items-center gap-2 pt-1 text-sm">
                <input
                  type="checkbox"
                  checked={residential}
                  disabled={frozen}
                  onChange={(event) => {
                    setResidential(event.target.checked);
                    stale();
                  }}
                />
                Residential address
              </label>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="to-signature">Delivery signature</Label>
                <Select
                  id="to-signature"
                  value={signature}
                  disabled={frozen}
                  onChange={(event) => {
                    const next = event.target.value as Signature;
                    setSignature(next);
                    chose.current = { ...chose.current, signature: next };
                    stale();
                    touched();
                  }}
                >
                  {(Object.keys(SIGNATURE_WORDS) as Signature[]).map((key) => (
                    <option key={key} value={key}>
                      {SIGNATURE_WORDS[key]}
                    </option>
                  ))}
                </Select>
                {start.signatureNote && (
                  <span className="text-muted-foreground max-w-64 text-xs">
                    {start.signatureNote}
                  </span>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <CardTitle>
              {showBoxes ? "Items & boxes" : "Items"} · {itemCount}{" "}
              {itemCount === 1 ? "item" : "items"}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              {canSave && showBoxes && mode === "saved" ? (
                <span className="text-muted-foreground text-xs">
                  Your saved choices
                  {resets?.plan && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        disabled={frozen}
                        title="Forget what was set up for this order and go back to its plan"
                        className="text-ochre-text font-semibold hover:underline disabled:opacity-50"
                        onClick={() => resetTo(resets.plan!, true)}
                      >
                        Reset
                      </button>
                    </>
                  )}
                </span>
              ) : canSave && showBoxes && start.source.startsWith("learned") ? (
                <span className="text-muted-foreground text-xs">
                  {start.source === "learned"
                    ? "Packed the way you packed these items last time"
                    : "In the box you used for these products before"}
                  {resets?.usual && (
                    <>
                      {" · "}
                      <button
                        type="button"
                        disabled={frozen}
                        className="text-ochre-text font-semibold hover:underline disabled:opacity-50"
                        onClick={() => resetTo(resets.usual!, false)}
                      >
                        Use the usual box
                      </button>
                    </>
                  )}
                </span>
              ) : showBoxes && !off && start.source === "rule" ? (
                <span className="text-muted-foreground text-xs">Box chosen by a rule</span>
              ) : null}
              {total !== null && total > 0 && (
                <span className="text-muted-foreground text-xs">
                  {several ? `${packed.length} boxes · ` : ""}Total{" "}
                  <span className="text-foreground font-semibold tabular-nums">
                    {formatTenthOz(total)}
                  </span>
                </span>
              )}
              {!off && several && lines.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={frozen}
                  title="Spread the items so each box weighs about the same"
                  onClick={() => repack(() => splitEvenly(lines, packed.length))}
                >
                  Split evenly
                </Button>
              )}
              {record && (
                <Button
                  type="button"
                  variant={recording ? "dark" : "outline"}
                  size="sm"
                  aria-expanded={recording}
                  aria-controls="record-by-hand"
                  title="Some items not ready? Send what you have now; the rest stays on your to-send list."
                  onClick={() => (recording ? setRecording(false) : openRecord())}
                >
                  Ship part of this order
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {showBoxes && (
            <>
              <fieldset
                disabled={frozen}
                className="grid gap-3 sm:grid-cols-[repeat(auto-fill,minmax(17.5rem,1fr))]"
              >
                {packed.map((box, index) => {
                  const id = (field: string) => `box-${box.key}-${field}`;
                  const inside = unitsIn(box.alloc, lines);
                  return (
                    <div
                      key={box.key}
                      role="group"
                      aria-label={`Box ${index + 1}`}
                      className="border-border bg-sunken flex min-w-0 flex-col gap-2 rounded-md border p-3"
                    >
                      <div className="flex min-h-[30px] items-center gap-2">
                        <span className="text-sm font-bold whitespace-nowrap">
                          {several ? `Box ${index + 1}` : "Box"}
                        </span>
                        {several &&
                          lines.length > 0 &&
                          (inside > 0 ? (
                            <span className="text-muted-foreground text-xs">
                              {inside} {inside === 1 ? "item" : "items"}
                            </span>
                          ) : (
                            <span
                              className="text-brick text-xs"
                              title="Move items into this box below"
                            >
                              Empty
                            </span>
                          ))}
                        {index > 0 && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="ml-auto"
                            onClick={() => removeBox(box.key)}
                            aria-label={`Remove box ${index + 1}`}
                          >
                            Remove
                          </Button>
                        )}
                      </div>
                      <Select
                        id={id("box")}
                        aria-label={`Box ${index + 1} size`}
                        value={box.boxId}
                        title={boxes.find((saved) => saved.id === box.boxId)?.size}
                        onChange={(event) => pickBox(box.key, event.target.value)}
                      >
                        {boxes.map((saved) => (
                          <option key={saved.id} value={saved.id}>
                            {saved.name}
                          </option>
                        ))}
                        <option value={CUSTOM}>Another size…</option>
                      </Select>
                      <div className="grid grid-cols-4 gap-2">
                        {(["length", "width", "height"] as const).map((side) => (
                          <div key={side} className="flex min-w-0 flex-col gap-1">
                            <Label htmlFor={id(side)} className="text-[11.5px]">
                              {side[0].toUpperCase()} in
                            </Label>
                            <Input
                              id={id(side)}
                              inputMode="decimal"
                              className="px-2"
                              value={box.size[side]}
                              onChange={(event) => typeSize(box.key, side, event.target.value)}
                            />
                          </div>
                        ))}
                        <div className="flex min-w-0 flex-col gap-1">
                          <Label htmlFor={id("weight")} className="text-[11.5px] whitespace-nowrap">
                            Weight lb
                          </Label>
                          <Input
                            id={id("weight")}
                            inputMode="decimal"
                            className="px-2"
                            value={box.weight}
                            title={
                              box.weightTyped || box.exact === null
                                ? undefined
                                : `${formatTenthOz(box.exact)}: the items${several || (picked && picked.emptyTenthOz > 0) ? " plus the box" : ""}, from your shop's weights`
                            }
                            onChange={(event) => typeWeight(box.key, event.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!off && packed.length < MAX_BOXES && (
                  <button
                    type="button"
                    onClick={addBox}
                    title="Too much for one box? Each box gets its own label and tracking number."
                    className="border-input text-text-2 hover:bg-sunken hover:text-foreground focus-visible:ring-ring flex min-h-12 items-center justify-center gap-2 rounded-md border-[1.5px] border-dashed p-3 text-[13px] font-semibold outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 sm:flex-col sm:gap-1.5"
                  >
                    <Plus className="size-4" aria-hidden />
                    Add another box
                  </button>
                )}
              </fieldset>
              {!off && (
                <p className="text-muted-foreground -mt-1 text-xs">
                  {several
                    ? known
                      ? "Each box's weight follows what you put in it; type over it if the scale says otherwise. The boxes are bought together, with a label for each."
                      : "Weigh each packed box. They're bought together as one purchase, with a label for each box."
                    : contentsTenthOz === null
                      ? "Your shop didn't give a weight for this order, so pop it on the scale."
                      : picked && picked.emptyTenthOz > 0 && !first.weightTyped
                        ? "The weight is what your shop says the items weigh, plus this box."
                        : "The weight starts from what your shop says the items weigh."}
                </p>
              )}
            </>
          )}
          {!off && several && lines.length > 0 ? (
            <ul className="grid gap-x-5 xl:grid-cols-2">
              {lines.map((line) => {
                const loose = notInBox(
                  packed.map((box) => box.alloc),
                  line,
                );
                return (
                  <li
                    key={line.id}
                    className="border-border flex flex-wrap items-center gap-x-3 gap-y-2 border-t py-2 text-sm"
                  >
                    <ItemPhoto src={line.photo} />
                    <span className="min-w-[9rem] flex-1">
                      <span className="block leading-snug font-semibold">{line.title}</span>
                      <span className="text-muted-foreground block text-xs">
                        {line.detail || "No item code"} ·{" "}
                        <span className="text-ochre-text font-bold">× {line.qty}</span>
                      </span>
                    </span>
                    {line.qty === 1 ? (
                      <span
                        role="radiogroup"
                        aria-label={`Box for ${line.title}`}
                        className="border-input flex overflow-hidden rounded-sm border"
                      >
                        {packed.map((box, index) => {
                          const on = (box.alloc[line.id] ?? 0) > 0;
                          return (
                            <button
                              key={box.key}
                              type="button"
                              role="radio"
                              aria-checked={on}
                              disabled={frozen}
                              onClick={() => repack((allocs) => setQty(allocs, line, index, 1))}
                              className={`h-[30px] px-2.5 text-xs font-semibold ${on ? "bg-teal text-on-teal" : "bg-card hover:bg-hover"}`}
                            >
                              Box {index + 1}
                            </button>
                          );
                        })}
                      </span>
                    ) : (
                      <span className="flex flex-wrap items-end gap-2">
                        {packed.map((box, index) => (
                          <label key={box.key} className="flex flex-col gap-1">
                            <span className="text-muted-foreground text-xs">Box {index + 1}</span>
                            <Input
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={line.qty}
                              className="h-[30px] w-14 px-2 text-center"
                              aria-label={`${line.title} in box ${index + 1}`}
                              disabled={frozen}
                              value={box.alloc[line.id] ?? 0}
                              onChange={(event) =>
                                repack((allocs) =>
                                  setQty(allocs, line, index, Number(event.target.value)),
                                )
                              }
                            />
                          </label>
                        ))}
                      </span>
                    )}
                    {loose !== 0 && (
                      <span className="text-brick w-full text-xs font-semibold">
                        {loose} not in a box
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            children
          )}
          {record && recording && (
            <div
              id="record-by-hand"
              ref={recordRef}
              className="border-border flex scroll-mt-4 flex-col gap-3 border-t pt-4"
            >
              <div>
                <p className="text-sm font-semibold">
                  {off ? "Record the parcel by hand" : "Ship part of this order"}
                </p>
                <p className="text-muted-foreground text-sm">
                  {off
                    ? "Buy the postage wherever you usually do, then put the tracking number here. Lower a number to send part now."
                    : "A part shipment is recorded by hand for now: lower a number to send part of the order, buy that postage wherever you usually do, and put the tracking number here. The rest stays on your to-send list. This is also the place for postage you bought somewhere else."}
                </p>
              </div>
              {record}
            </div>
          )}
        </CardContent>
      </Card>

      {(!off || off.service) && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Service</CardTitle>
              {!off && (
                <div className="flex items-center gap-2">
                  {paid.amount && (
                    <span className="text-muted-foreground text-xs">
                      Margin = {paid.amount} paid − label
                    </span>
                  )}
                  {!locked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={quoteNow}
                      disabled={busy}
                      aria-label={rates ? "Refresh rates" : "Get rates"}
                      title={rates ? "Refresh rates" : "Get rates"}
                    >
                      <RefreshCw className={quoting ? "animate-spin" : undefined} aria-hidden />
                    </Button>
                  )}
                </div>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {off ? (
              <p className="text-muted-foreground text-sm">{off.service}</p>
            ) : rates && !locked ? (
              <fieldset disabled={busy}>
                <legend className="sr-only">Choose a service, cheapest first</legend>
                <ul className="flex flex-col gap-2">
                  {rates.map((item, index) => {
                    const left = leftOver(paid.cents, item.price, item.currency);
                    const mark = carrierMark(item.carrier);
                    const on = chosen === item.id;
                    return (
                      <li key={item.id}>
                        <label
                          className={`flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2.5 text-sm ${on ? "border-ochre ring-ochre-soft ring-[3px]" : "border-border hover:border-input"}`}
                        >
                          <input
                            type="radio"
                            name="label-rate"
                            value={item.id}
                            checked={on}
                            onChange={() => pickRate(item)}
                            className="accent-ochre size-[18px] shrink-0"
                          />
                          <span
                            aria-hidden
                            title={item.carrier}
                            className={`hidden h-[26px] min-w-[46px] shrink-0 place-items-center rounded-md px-1.5 text-[11px] leading-none font-extrabold tracking-wide sm:grid ${mark.key === "other" ? "bg-sunken text-text-2" : ""}`}
                            style={MARK_TONES[mark.key]}
                          >
                            {mark.label}
                          </span>
                          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                              <span className="font-bold">{item.name}</span>
                              <SourceChip source={item.source} />
                              {testSources.includes(item.source) && sources.length > 1 && (
                                <Badge tone="waiting">Test label</Badge>
                              )}
                            </span>
                            <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                              {item.days !== null
                                ? `Est. ${deliveryDays(item.days)}`
                                : "Transit time varies"}
                              {index === 0 && <Badge>Cheapest</Badge>}
                              {item.id === ruleRateId && <Badge tone="open">By rule</Badge>}
                              {sameService(paid.method, item.carrier, item.name) && (
                                <Badge>Customer&apos;s choice</Badge>
                              )}
                            </span>
                            {item.note && (
                              <span className="text-muted-foreground text-xs">{item.note}</span>
                            )}
                            {item.others && item.others.length > 0 && (
                              <span className="text-muted-foreground text-xs tabular-nums">
                                Also{" "}
                                {item.others
                                  .map(
                                    (other) =>
                                      `${SOURCE_NAMES[other.source]} ${formatPrice(other.price, item.currency)}`,
                                  )
                                  .join(" · ")}
                              </span>
                            )}
                          </span>
                          <span className="text-right tabular-nums">
                            <span className="block text-base font-extrabold">
                              {formatPrice(item.price, item.currency)}
                            </span>
                            {left && (
                              <span
                                className={`block text-xs font-medium whitespace-nowrap ${left.short ? "text-brick" : "text-mint-ink"}`}
                              >
                                {left.short ? "−" : "+"}
                                {left.amount} margin
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                {notes.length > 0 && (
                  <ul className="text-muted-foreground mt-3 flex flex-col gap-1 text-xs">
                    {notes.map((note) => (
                      <li key={note}>{note}</li>
                    ))}
                  </ul>
                )}
                <p className="text-muted-foreground mt-3 text-xs">
                  {paidFrom(rate?.source ?? null, sources)}
                </p>
              </fieldset>
            ) : (
              <p className="text-muted-foreground text-sm">
                {locked
                  ? "No more rates on this screen: a label is already being sorted out."
                  : quoting
                    ? "Asking the carriers…"
                    : several
                      ? "Rates appear here once the address and every box's size and weight are set. Each price covers all the boxes."
                      : "Rates appear here once the address, box and weight are set."}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

/** A square thumbnail of the item, or a quiet tile where the shop gave no picture. */
function ItemPhoto({ src }: { src: string | null }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture of the product, on the shop's image servers
    <img
      src={src}
      alt=""
      loading="lazy"
      className="border-border size-12 shrink-0 rounded-md border bg-white object-cover"
    />
  ) : (
    <span className="bg-sunken border-border size-12 shrink-0 rounded-md border" aria-hidden />
  );
}

function AddressVerdict({
  checked,
  residential,
  onCheck,
  onUse,
}: {
  checked: Checked;
  residential: boolean;
  onCheck: () => void;
  onUse: (suggestion: NonNullable<AddressCheck["suggestion"]>) => void;
}) {
  const row = "flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm";
  if (checked.state === "skipped") {
    return (
      <p className={`${row} bg-sunken text-muted-foreground`}>
        This address hasn&apos;t been checked: none of your connected postage accounts checks
        addresses here. Look it over before you buy.
      </p>
    );
  }
  if (checked.state === "idle" || checked.state === "checking") {
    return <p className={`${row} bg-sunken text-muted-foreground`}>Checking the address…</p>;
  }
  if (checked.state === "edited" || checked.state === "failed") {
    return (
      <p className={`${row} bg-sunken`}>
        <span>{checked.state === "failed" ? checked.message : "You changed the address."}</span>
        <Button type="button" variant="outline" size="sm" onClick={onCheck}>
          Check address
        </Button>
      </p>
    );
  }
  const { check } = checked;
  if (!check.found) {
    return (
      <p className={`${row} bg-brick-soft text-brick`}>
        <TriangleAlert className="size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold">The carriers don&apos;t know this address.</span>{" "}
          {check.problem ? `${check.problem}. ` : ""}Look it over before you buy.
        </span>
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className={`${row} bg-mint-soft text-mint-ink`}>
        <Check className="size-4 shrink-0" aria-hidden />
        <span>
          <span className="font-semibold">Address found</span> ·{" "}
          {residential ? "residential address" : "business address"}
        </span>
      </p>
      {check.suggestion && (
        <p className={`${row} bg-note`}>
          <span>
            The carriers write it as{" "}
            <span className="font-read font-medium">
              {[
                check.suggestion.street1,
                check.suggestion.street2,
                check.suggestion.city,
                [check.suggestion.state, check.suggestion.zip].filter(Boolean).join(" "),
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onUse(check.suggestion!)}
          >
            Use this
          </Button>
        </p>
      )}
    </div>
  );
}
