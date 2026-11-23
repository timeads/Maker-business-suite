"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { Check, Plus, Printer, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import {
  MAX_BOXES,
  formatPrice,
  formatTenthOz,
  lbOzToTenthOz,
  tenthOzToLbOz,
  type AddressCheck,
  type Signature,
} from "@/lib/shipping/easypost";
import { deliveryDays, type ShipToEdit } from "@/lib/shipping/labels";
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
import type { SourceRateChoice } from "@/lib/shipping/sources/rates";
import {
  SOURCE_CHIPS,
  SOURCE_NAMES,
  SOURCE_PAID_FROM,
  type LabelSourceKey,
} from "@/lib/shipping/sources/types";
import { buyLabel, checkLabelAddress, getLabelRates, type RatesInput } from "./label-actions";

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

/** One box on the bench: which saved box (or none), its size and what it weighs packed. */
type Packed = {
  /** Stays with the box while others come and go, for React and the field ids. */
  key: number;
  boxId: string;
  size: { length: string; width: string; height: string };
  weight: { lb: string; oz: string };
  /** The weight was typed by hand, so picking another box leaves it alone. */
  weightTyped: boolean;
  /** How many of each item are in this box. */
  alloc: Alloc;
};

/** What all the boxes weigh together, in tenths of an ounce; null while any isn't a number. */
function totalTenthOz(packed: Packed[]): number | null {
  let total = 0;
  for (const box of packed) {
    const tenths = lbOzToTenthOz(box.weight.lb, box.weight.oz);
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
    <span className="border-border text-muted-foreground rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap">
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

const FIELDS: { key: keyof ShipToEdit; label: string; span: string; max: number }[] = [
  { key: "recipient", label: "Name", span: "sm:col-span-4", max: 120 },
  { key: "company", label: "Company", span: "sm:col-span-4", max: 120 },
  { key: "phone", label: "Phone", span: "sm:col-span-4", max: 30 },
  { key: "address1", label: "Address", span: "sm:col-span-8", max: 120 },
  { key: "address2", label: "Apt / suite", span: "sm:col-span-4", max: 120 },
  { key: "city", label: "City", span: "sm:col-span-5", max: 120 },
  { key: "region", label: "State", span: "sm:col-span-2", max: 60 },
  { key: "postal_code", label: "ZIP", span: "sm:col-span-3", max: 20 },
];

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
  contentsTenthOz,
  paid,
  rule,
  shop,
  sources,
  testSources,
  setup,
  lines,
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
  /** What the shop says the items weigh, in tenths of an ounce. */
  contentsTenthOz: number | null;
  /** What the shopper paid for shipping and the option they picked. */
  paid: { cents: number | null; words: string; method: string | null };
  /** The workspace's signature rule, when this order is worth enough for it. */
  rule: string | null;
  shop: { offered: boolean; markSent: boolean; notify: boolean };
  /** The connected places to buy postage: every one is asked for its prices. */
  sources: LabelSourceKey[];
  /** Those of them whose labels are practice ones, not real postage. */
  testSources: LabelSourceKey[];
  /** What's still missing before a carrier will quote, with where to fix it. */
  setup: { missing: string; href: string | null } | null;
  /** The items going in this purchase, for dividing between several boxes. */
  lines: DeskLine[];
  /** The items in the order, shown under the box. */
  children: React.ReactNode;
}) {
  const startWeight = (box: DeskBox | undefined) =>
    contentsTenthOz === null
      ? { lb: "", oz: "" }
      : tenthOzToLbOz(contentsTenthOz + (box?.emptyTenthOz ?? 0));
  const [to, setTo] = useState(shipTo);
  const [checked, setChecked] = useState<Checked>({ state: "idle" });
  const [residential, setResidential] = useState(true);
  const [signature, setSignature] = useState<Signature>(rule ? "signature" : "none");
  const sizeOf = (box: DeskBox | undefined) => ({
    length: box?.length ?? "",
    width: box?.width ?? "",
    height: box?.height ?? "",
  });
  // The order starts in one box: the usual one, at the weight the shop gave.
  const [packed, setPacked] = useState<Packed[]>(() => [
    {
      key: 0,
      boxId: boxes[0]?.id ?? CUSTOM,
      size: sizeOf(boxes[0]),
      weight: startWeight(boxes[0]),
      weightTyped: false,
      alloc: fullAlloc(lines),
    },
  ]);
  // With a weight for every item, each box's weight follows what's put in it.
  const known = weightsKnown(lines);
  const reweigh = (list: Packed[]): Packed[] =>
    list.length > 1 && known
      ? list.map((box) =>
          box.weightTyped
            ? box
            : {
                ...box,
                weight: tenthOzToLbOz(
                  (boxes.find((saved) => saved.id === box.boxId)?.emptyTenthOz ?? 0) +
                    boxContentsTenthOz(box.alloc, lines),
                ),
              },
        )
      : list;
  const nextKey = useRef(1);
  const [rates, setRates] = useState<SourceRateChoice[] | null>(null);
  /** A word on each connected account that couldn't be asked this time. */
  const [notes, setNotes] = useState<string[]>([]);
  /** Exactly what the rates on screen were asked with: buying sends the same again. */
  const asked = useRef<RatesInput | null>(null);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [markSent, setMarkSent] = useState(shop.offered && shop.markSent);
  const [notify, setNotify] = useState(shop.notify);
  /** Money was spent (or may have been): never offer Buy again on this screen. */
  const [locked, setLocked] = useState(false);
  const [quoting, startQuote] = useTransition();
  const [buying, startBuy] = useTransition();
  const sent = useRef(false);
  const opened = useRef(false);

  // A price belongs to one address and one set of boxes and weights: change any and it's gone.
  const stale = () => {
    setRates(null);
    setNotes([]);
    asked.current = null;
    setChosen("");
    setError(null);
  };

  // One steady list, so asking for rates doesn't start over on every render.
  const withKey = (withIds ?? []).join(",");
  const together = useMemo(() => (withKey ? withKey.split(",") : undefined), [withKey]);
  type Ask = { to: ShipToEdit; residential: boolean; signature: Signature };
  const quote = useCallback(
    (ask: Ask, parcels: Pick<Packed, "boxId" | "size" | "weight">[]) =>
      startQuote(async () => {
        setError(null);
        const input: RatesInput = {
          boxes: parcels.map((parcel) => ({
            boxId: parcel.boxId,
            ...parcel.size,
            weightLb: parcel.weight.lb,
            weightOz: parcel.weight.oz,
          })),
          shipTo: ask.to,
          residential: ask.residential,
          signature: ask.signature,
          withIds: together,
        };
        const result = await getLabelRates(slug, orderId, input);
        if (result.error || !result.rates) {
          setRates(null);
          setNotes([]);
          asked.current = null;
          setError(result.error ?? "We couldn't get rates. Try again.");
          return;
        }
        asked.current = input;
        setNotes(result.notes ?? []);
        setRates(result.rates);
        setChosen(result.rates[0]?.id ?? "");
      }),
    [slug, orderId, together],
  );
  const quoteNow = () => quote({ to, residential, signature }, packed);

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

  // On opening: check the address, then ask for prices if the box and weight are known,
  // so the next order is ready to buy by the time it's on screen. Only ever for the one
  // box an order starts in; more boxes are asked for by hand.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void (async () => {
      const found = await check(shipTo);
      const first = boxes[0];
      const starting = startWeight(first);
      if (setup || !first || (!starting.lb && !starting.oz)) return;
      quote(
        {
          to: shipTo,
          residential: found?.residential ?? true,
          signature: rule ? "signature" : "none",
        },
        [{ boxId: first.id, size: sizeOf(first), weight: starting }],
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
  };
  const pickBox = (key: number, id: string) => {
    const saved = boxes.find((box) => box.id === id);
    change(key, (box) => ({
      ...box,
      boxId: id,
      size: id === CUSTOM ? box.size : sizeOf(saved),
      weight: box.weightTyped ? box.weight : startWeight(saved),
    }));
  };
  const typeSize = (key: number, side: keyof Packed["size"], value: string) =>
    // A size typed by hand is its own box, not the saved one.
    change(key, (box) => ({ ...box, boxId: CUSTOM, size: { ...box.size, [side]: value } }));
  const typeWeight = (key: number, part: "lb" | "oz", value: string) =>
    change(key, (box) => ({
      ...box,
      weight: { ...box.weight, [part]: value },
      weightTyped: true,
    }));
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
          weight: { lb: "", oz: "" },
          weightTyped: !known,
          alloc: emptyAlloc(lines),
        },
      ]);
    });
    stale();
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
        return [{ ...kept[0], weight: startWeight(saved) }];
      }
      return reweigh(kept);
    });
    stale();
  };

  const rate = rates?.find((item) => item.id === chosen) ?? null;
  const busy = quoting || buying;
  const canBuy = Boolean(rate) && !busy && !locked;

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
        asked.current ?? undefined,
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
  }, [slug, orderId, together, chosen, locked, markSent, notify, packed, lines]);

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
  const total = totalTenthOz(packed);
  const margin = rate ? leftOver(paid.cents, rate.price, rate.currency) : null;
  // Said only where an account reports it, and only while it could be the one that's used.
  const testNote =
    rate && testSources.includes(rate.source)
      ? sources.length > 1
        ? `Test mode: ${SOURCE_NAMES[rate.source]} labels are not real`
        : "Test mode: labels are not real"
      : !rate && testSources.length > 0
        ? testSources.length === sources.length && sources.length === 1
          ? "Test mode: labels are not real"
          : `Test mode: ${testSources.map((key) => SOURCE_NAMES[key]).join(" and ")} labels are not real`
        : null;
  const stat = "flex flex-col gap-0.5";
  const statLabel = "text-muted-foreground text-xs font-semibold";

  return (
    <>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <div className="flex flex-wrap items-center gap-x-8 gap-y-3">
            {rate ? (
              <>
                <div className={stat}>
                  <span className={statLabel}>Service</span>
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    {rate.name}
                    <SourceChip source={rate.source} />
                  </span>
                  {rate.days !== null && (
                    <span className="text-muted-foreground text-xs">
                      Est. {deliveryDays(rate.days)}
                    </span>
                  )}
                </div>
                <div className={stat}>
                  <span className={statLabel}>{several ? `${packed.length} labels` : "Label"}</span>
                  <span className="font-semibold tabular-nums">
                    {formatPrice(rate.price, rate.currency)}
                  </span>
                </div>
                <div className={stat}>
                  <span className={statLabel}>Customer paid</span>
                  <span className="font-semibold tabular-nums">{paid.words}</span>
                  {paid.method && (
                    <span className="text-muted-foreground text-xs">{paid.method}</span>
                  )}
                </div>
                {margin && (
                  <div className={stat}>
                    <span className={statLabel}>{margin.short ? "Short by" : "Left over"}</span>
                    <span
                      className={`font-semibold tabular-nums ${margin.short ? "text-brick" : "text-mint-ink"}`}
                    >
                      {margin.short ? "−" : "+"}
                      {margin.amount}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm">
                {locked
                  ? "This label is being sorted out. See the message below."
                  : quoting
                    ? "Asking the carriers what this would cost…"
                    : several
                      ? "Check the address and each box's size and weight, then get rates."
                      : "Check the address, box and weight, then get rates."}
              </p>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {testNote && <Badge tone="waiting">{testNote}</Badge>}
              {!locked &&
                (rates ? (
                  <Button type="button" size="lg" onClick={buy} disabled={!canBuy}>
                    <Printer aria-hidden />
                    {buying
                      ? several
                        ? "Buying your labels…"
                        : "Buying your label…"
                      : several
                        ? `Buy & print ${packed.length} labels`
                        : "Buy & print label"}
                    <kbd className="rounded-sm border border-current/30 px-1 font-sans text-[10px] opacity-80">
                      Ctrl+P
                    </kbd>
                  </Button>
                ) : (
                  <Button type="button" variant="outline" onClick={quoteNow} disabled={busy}>
                    {quoting ? "Asking the carriers…" : "Get rates"}
                  </Button>
                ))}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={markSent}
                disabled={!shop.offered || busy || locked}
                onChange={(event) => setMarkSent(event.target.checked)}
              />
              {together
                ? "Mark every one of these orders as sent in my shop"
                : "Mark the order as sent in my shop"}
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
            <span className="text-muted-foreground ml-auto text-xs">
              {shop.offered
                ? paidFrom(rate?.source ?? null, sources)
                : "Your shop hasn't given permission to mark orders as sent, so do that there yourself."}
            </span>
          </div>
          <FormMessage>{error}</FormMessage>
        </CardContent>
      </Card>

      {setup && (
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

      {rule && signature !== "none" && (
        <p className="bg-note border-note-border rounded-lg border px-4 py-2.5 text-sm">
          <span className="font-semibold">Rule applied:</span> {rule}
        </p>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Ship to</CardTitle>
            <span className="text-muted-foreground text-xs">Changes apply to this label only</span>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <AddressVerdict
            checked={checked}
            residential={residential}
            onCheck={() => void check(to, true)}
            onUse={takeSuggestion}
          />
          <fieldset disabled={busy || locked} className="grid gap-3 sm:grid-cols-12">
            {FIELDS.map((field) => (
              <div key={field.key} className={`flex flex-col gap-1.5 ${field.span}`}>
                <Label htmlFor={`to-${field.key}`}>{field.label}</Label>
                <Input
                  id={`to-${field.key}`}
                  value={to[field.key]}
                  maxLength={field.max}
                  onChange={(event) => typeAddress(field.key, event.target.value)}
                />
              </div>
            ))}
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="to-country">Country</Label>
              <Input id="to-country" value={country} readOnly disabled />
            </div>
          </fieldset>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={residential}
                disabled={busy || locked}
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
                disabled={busy || locked}
                onChange={(event) => {
                  setSignature(event.target.value as Signature);
                  stale();
                }}
              >
                {(Object.keys(SIGNATURE_WORDS) as Signature[]).map((key) => (
                  <option key={key} value={key}>
                    {SIGNATURE_WORDS[key]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Items &amp; boxes</CardTitle>
            {total !== null && total > 0 && (
              <span className="text-muted-foreground text-xs">
                {several ? `${packed.length} boxes · ` : ""}Total{" "}
                <span className="text-foreground font-semibold tabular-nums">
                  {formatTenthOz(total)}
                </span>
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <fieldset disabled={busy || locked} className="grid gap-3 sm:grid-cols-2">
            {packed.map((box, index) => {
              const id = (field: string) => `box-${box.key}-${field}`;
              return (
                <div
                  key={box.key}
                  role="group"
                  aria-label={`Box ${index + 1}`}
                  className="border-border grid grid-cols-6 gap-x-2 gap-y-3 rounded-md border p-3"
                >
                  <div className="col-span-6 flex min-h-8 items-center justify-between gap-2">
                    <span className="text-sm font-semibold">Box {index + 1}</span>
                    {index > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeBox(box.key)}
                        aria-label={`Remove box ${index + 1}`}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                  <div className="col-span-6 flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={id("box")}>Box</Label>
                    <Select
                      id={id("box")}
                      value={box.boxId}
                      onChange={(event) => pickBox(box.key, event.target.value)}
                    >
                      {boxes.map((saved) => (
                        <option key={saved.id} value={saved.id}>
                          {saved.name} ({saved.size})
                        </option>
                      ))}
                      <option value={CUSTOM}>Another size…</option>
                    </Select>
                  </div>
                  {(["length", "width", "height"] as const).map((side) => (
                    <div key={side} className="col-span-2 flex min-w-0 flex-col gap-1.5">
                      <Label htmlFor={id(side)}>{side[0].toUpperCase()} in</Label>
                      <Input
                        id={id(side)}
                        inputMode="decimal"
                        value={box.size[side]}
                        onChange={(event) => typeSize(box.key, side, event.target.value)}
                      />
                    </div>
                  ))}
                  <div className="col-span-3 flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={id("lb")}>Weight lb</Label>
                    <Input
                      id={id("lb")}
                      inputMode="decimal"
                      value={box.weight.lb}
                      onChange={(event) => typeWeight(box.key, "lb", event.target.value)}
                    />
                  </div>
                  <div className="col-span-3 flex min-w-0 flex-col gap-1.5">
                    <Label htmlFor={id("oz")}>oz</Label>
                    <Input
                      id={id("oz")}
                      inputMode="decimal"
                      value={box.weight.oz}
                      onChange={(event) => typeWeight(box.key, "oz", event.target.value)}
                    />
                  </div>
                </div>
              );
            })}
            {packed.length < MAX_BOXES && (
              <button
                type="button"
                onClick={addBox}
                className="border-border text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:ring-ring flex min-h-24 items-center justify-center gap-2 rounded-md border border-dashed p-3 text-sm font-semibold outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50"
              >
                <Plus className="size-4" aria-hidden />
                Add another box
              </button>
            )}
          </fieldset>
          <p className="text-muted-foreground -mt-2 text-xs">
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
          {several && lines.length > 0 ? (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">What goes in each box</p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={busy || locked}
                  title="Spread the items so each box weighs about the same"
                  onClick={() => repack(() => splitEvenly(lines, packed.length))}
                >
                  Split evenly
                </Button>
              </div>
              <ul className="divide-border border-border flex flex-col divide-y rounded-md border">
                {lines.map((line) => {
                  const loose = notInBox(
                    packed.map((box) => box.alloc),
                    line,
                  );
                  return (
                    <li
                      key={line.id}
                      className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 text-sm"
                    >
                      {line.photo ? (
                        // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture of the product, on the shop's image servers
                        <img
                          src={line.photo}
                          alt=""
                          loading="lazy"
                          className="border-border size-10 shrink-0 rounded-md border object-cover"
                        />
                      ) : (
                        <span className="bg-sunken size-10 shrink-0 rounded-md" aria-hidden />
                      )}
                      <span className="min-w-[10rem] flex-1">
                        <span className="block font-semibold">{line.title}</span>
                        <span className="text-muted-foreground block text-xs">
                          {line.detail || "No item code"} · × {line.qty}
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
                                disabled={busy || locked}
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
                                className="h-[30px] w-16"
                                aria-label={`${line.title} in box ${index + 1}`}
                                disabled={busy || locked}
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
                        <span className="text-brick w-full text-xs font-semibold sm:w-auto">
                          {loose} not in a box
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            children
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Service</CardTitle>
            {!locked && (
              <Button type="button" variant="ghost" size="sm" onClick={quoteNow} disabled={busy}>
                <RefreshCw aria-hidden />
                {quoting ? "Checking…" : rates ? "Refresh rates" : "Get rates"}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {rates && !locked ? (
            <fieldset disabled={busy}>
              <legend className="sr-only">Choose a service, cheapest first</legend>
              <ul className="divide-border border-border flex flex-col divide-y rounded-md border">
                {rates.map((item, index) => {
                  const left = leftOver(paid.cents, item.price, item.currency);
                  return (
                    <li key={item.id}>
                      <label
                        className={`hover:bg-hover flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm ${chosen === item.id ? "bg-hover" : ""}`}
                      >
                        <input
                          type="radio"
                          name="label-rate"
                          value={item.id}
                          checked={chosen === item.id}
                          onChange={() => setChosen(item.id)}
                        />
                        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="font-semibold">{item.name}</span>
                          <SourceChip source={item.source} />
                          {item.days !== null && (
                            <span className="text-muted-foreground">
                              Est. {deliveryDays(item.days)}
                            </span>
                          )}
                          {index === 0 && <Badge tone="good">Cheapest</Badge>}
                          {testSources.includes(item.source) && sources.length > 1 && (
                            <Badge tone="waiting">Test label</Badge>
                          )}
                          {(item.others?.length || item.note) && (
                            <span className="text-muted-foreground basis-full text-xs">
                              {item.others?.length
                                ? `Also ${item.others
                                    .map(
                                      (other) =>
                                        `${SOURCE_NAMES[other.source]} ${formatPrice(other.price, item.currency)}`,
                                    )
                                    .join(" · ")}`
                                : ""}
                              {item.others?.length && item.note ? ". " : ""}
                              {item.note ?? ""}
                            </span>
                          )}
                        </span>
                        <span className="text-right font-semibold tabular-nums">
                          {formatPrice(item.price, item.currency)}
                          {left && (
                            <span
                              className={`block text-xs font-medium ${left.short ? "text-brick" : "text-mint-ink"}`}
                            >
                              {left.short ? `${left.amount} short` : `${left.amount} left over`}
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
    </>
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
          {residential ? "a home address" : "a business address"}
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
