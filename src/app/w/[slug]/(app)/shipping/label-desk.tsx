"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Check, Printer, RefreshCw, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import {
  formatPrice,
  tenthOzToLbOz,
  type AddressCheck,
  type Signature,
} from "@/lib/shipping/easypost";
import { deliveryDays, type RateChoice, type ShipToEdit } from "@/lib/shipping/labels";
import { buyLabel, checkLabelAddress, getLabelRates } from "./label-actions";

export type DeskBox = {
  id: string;
  name: string;
  /** "12 × 9 × 4 in" */
  size: string;
  /** The box's own weight, in tenths of an ounce. */
  emptyTenthOz: number;
};

const CUSTOM = "";

type Checked =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "edited" }
  | { state: "done"; check: AddressCheck }
  | { state: "failed"; message: string };

const SIGNATURE_WORDS: Record<Signature, string> = {
  none: "No signature",
  signature: "Signature required",
  adult: "Adult signature required",
};

const FIELDS: { key: keyof ShipToEdit; label: string; span: string; max: number }[] = [
  { key: "recipient", label: "Name", span: "sm:col-span-2", max: 120 },
  { key: "company", label: "Company", span: "sm:col-span-2", max: 120 },
  { key: "phone", label: "Phone", span: "sm:col-span-2", max: 30 },
  { key: "address1", label: "Address", span: "sm:col-span-4", max: 120 },
  { key: "address2", label: "Apt / suite", span: "sm:col-span-2", max: 120 },
  { key: "city", label: "City", span: "sm:col-span-3", max: 120 },
  { key: "region", label: "State", span: "sm:col-span-1", max: 60 },
  { key: "postal_code", label: "ZIP", span: "sm:col-span-2", max: 20 },
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
  shipTo,
  country,
  boxes,
  contentsTenthOz,
  paid,
  rule,
  shop,
  testMode,
  children,
}: {
  slug: string;
  orderId: string;
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
  testMode: boolean;
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
  const [boxId, setBoxId] = useState(boxes[0]?.id ?? CUSTOM);
  const [size, setSize] = useState({ length: "", width: "", height: "" });
  const [weight, setWeight] = useState(() => startWeight(boxes[0]));
  const [weightTyped, setWeightTyped] = useState(false);
  const [rates, setRates] = useState<RateChoice[] | null>(null);
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

  // A price belongs to one address, one box and one weight: change any and it's gone.
  const stale = () => {
    setRates(null);
    setChosen("");
    setError(null);
  };

  type Ask = { to: ShipToEdit; residential: boolean; signature: Signature };
  const quote = useCallback(
    (ask: Ask, parcel: { boxId: string; size: typeof size; weight: typeof weight }) =>
      startQuote(async () => {
        setError(null);
        const result = await getLabelRates(slug, orderId, {
          boxId: parcel.boxId,
          ...parcel.size,
          weightLb: parcel.weight.lb,
          weightOz: parcel.weight.oz,
          shipTo: ask.to,
          residential: ask.residential,
          signature: ask.signature,
        });
        if (result.error || !result.rates) {
          setRates(null);
          setError(result.error ?? "We couldn't get rates. Try again.");
          return;
        }
        setRates(result.rates);
        setChosen(result.rates[0]?.id ?? "");
      }),
    [slug, orderId],
  );
  const quoteNow = () => quote({ to, residential, signature }, { boxId, size, weight });

  const check = useCallback(
    async (address: ShipToEdit): Promise<AddressCheck | null> => {
      setChecked({ state: "checking" });
      const result = await checkLabelAddress(slug, orderId, address);
      if (!result.check) {
        setChecked({ state: "failed", message: result.error ?? "We couldn't check the address." });
        return null;
      }
      setChecked({ state: "done", check: result.check });
      if (result.check.residential !== null) setResidential(result.check.residential);
      return result.check;
    },
    [slug, orderId],
  );

  // On opening: check the address, then ask for prices if the box and weight are known,
  // so the next order is ready to buy by the time it's on screen.
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    void (async () => {
      const found = await check(shipTo);
      const first = boxes[0];
      const starting = startWeight(first);
      if (!first || (!starting.lb && !starting.oz)) return;
      quote(
        {
          to: shipTo,
          residential: found?.residential ?? true,
          signature: rule ? "signature" : "none",
        },
        { boxId: first.id, size: { length: "", width: "", height: "" }, weight: starting },
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
  const pickBox = (id: string) => {
    setBoxId(id);
    if (!weightTyped) setWeight(startWeight(boxes.find((box) => box.id === id)));
    stale();
  };
  const typeWeight = (part: "lb" | "oz", value: string) => {
    setWeight((before) => ({ ...before, [part]: value }));
    setWeightTyped(true);
    stale();
  };

  const rate = rates?.find((item) => item.id === chosen) ?? null;
  const busy = quoting || buying;
  const canBuy = Boolean(rate) && !busy && !locked;

  const buy = useCallback(() => {
    // One press, one purchase: the ref closes the gap before the button greys out.
    if (sent.current || locked || !chosen) return;
    sent.current = true;
    startBuy(async () => {
      setError(null);
      const result = await buyLabel(slug, orderId, chosen, { markSent, notify });
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
  }, [slug, orderId, chosen, locked, markSent, notify]);

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

  const picked = boxes.find((box) => box.id === boxId);
  const margin = rate ? leftOver(paid.cents, rate.price, rate.currency) : null;
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
                  <span className="font-semibold">{rate.name}</span>
                  {rate.days !== null && (
                    <span className="text-muted-foreground text-xs">
                      Est. {deliveryDays(rate.days)}
                    </span>
                  )}
                </div>
                <div className={stat}>
                  <span className={statLabel}>Label</span>
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
                    : "Check the address, box and weight, then get rates."}
              </p>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-2">
              {testMode && <Badge tone="waiting">Test mode: labels are not real</Badge>}
              {!locked &&
                (rates ? (
                  <Button type="button" size="lg" onClick={buy} disabled={!canBuy}>
                    <Printer aria-hidden />
                    {buying ? "Buying your label…" : "Buy & print label"}
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
              Mark the order as sent in my shop
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
                ? "Postage is paid from your EasyPost account."
                : "Your shop hasn't given permission to mark orders as sent, so do that there yourself."}
            </span>
          </div>
          <FormMessage>{error}</FormMessage>
        </CardContent>
      </Card>

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
            onCheck={() => void check(to)}
            onUse={takeSuggestion}
          />
          <fieldset disabled={busy || locked} className="grid gap-3 sm:grid-cols-6">
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
            <div className="flex flex-col gap-1.5 sm:col-span-6 sm:max-w-[8rem]">
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
          <CardTitle>Items &amp; box</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          <fieldset disabled={busy || locked} className="flex flex-wrap items-end gap-3">
            <div className="flex min-w-[14rem] flex-1 flex-col gap-1.5">
              <Label htmlFor="label-box">Box</Label>
              <Select
                id="label-box"
                value={boxId}
                onChange={(event) => pickBox(event.target.value)}
              >
                {boxes.map((box) => (
                  <option key={box.id} value={box.id}>
                    {box.name} ({box.size})
                  </option>
                ))}
                <option value={CUSTOM}>Another size…</option>
              </Select>
            </div>
            {boxId === CUSTOM &&
              (["length", "width", "height"] as const).map((side) => (
                <div key={side} className="flex w-20 flex-col gap-1.5">
                  <Label htmlFor={`box-${side}`}>{side[0].toUpperCase()} in</Label>
                  <Input
                    id={`box-${side}`}
                    inputMode="decimal"
                    value={size[side]}
                    onChange={(event) => {
                      setSize((before) => ({ ...before, [side]: event.target.value }));
                      stale();
                    }}
                  />
                </div>
              ))}
            <div className="flex w-20 flex-col gap-1.5">
              <Label htmlFor="box-lb">Weight lb</Label>
              <Input
                id="box-lb"
                inputMode="decimal"
                value={weight.lb}
                onChange={(event) => typeWeight("lb", event.target.value)}
              />
            </div>
            <div className="flex w-20 flex-col gap-1.5">
              <Label htmlFor="box-oz">oz</Label>
              <Input
                id="box-oz"
                inputMode="decimal"
                value={weight.oz}
                onChange={(event) => typeWeight("oz", event.target.value)}
              />
            </div>
          </fieldset>
          <p className="text-muted-foreground -mt-2 text-xs">
            {contentsTenthOz === null
              ? "Your shop didn't give a weight for this order, so pop it on the scale."
              : picked && picked.emptyTenthOz > 0 && !weightTyped
                ? "The weight is what your shop says the items weigh, plus this box."
                : "The weight starts from what your shop says the items weigh."}
          </p>
          {children}
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
                          {item.days !== null && (
                            <span className="text-muted-foreground">
                              Est. {deliveryDays(item.days)}
                            </span>
                          )}
                          {index === 0 && <Badge tone="good">Cheapest</Badge>}
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
            </fieldset>
          ) : (
            <p className="text-muted-foreground text-sm">
              {locked
                ? "No more rates on this screen: a label is already being sorted out."
                : quoting
                  ? "Asking the carriers…"
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
