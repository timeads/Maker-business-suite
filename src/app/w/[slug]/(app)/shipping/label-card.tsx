"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatPrice, tenthOzToLbOz } from "@/lib/shipping/easypost";
import { deliveryDays, type RateChoice } from "@/lib/shipping/labels";
import { buyLabel, finishLabel, getLabelRates } from "./label-actions";

/** What's left of the shipping the shopper paid once this label is bought. */
function Margin({
  paidCents,
  price,
  currency,
}: {
  paidCents: number | null;
  price: string;
  currency: string;
}) {
  const cost = Math.round(Number(price) * 100);
  if (paidCents === null || !Number.isFinite(cost)) return null;
  const left = paidCents - cost;
  const amount = formatPrice((Math.abs(left) / 100).toFixed(2), currency);
  return (
    <span className={`block text-xs font-medium ${left < 0 ? "text-brick" : "text-mint-ink"}`}>
      {left < 0 ? `${amount} more than they paid` : `${amount} left over`}
    </span>
  );
}

export type BoxChoice = {
  id: string;
  name: string;
  /** "12 × 9 × 4 in" */
  size: string;
  /** What the empty box weighs, in tenths of an ounce. */
  emptyTenthOz: number;
};

const CUSTOM = "";

/**
 * Choose a box, check the weight, see what each carrier would charge, buy.
 * The browser only ever sends the box, the weight and the rate picked: the
 * addresses and the prices are the server's.
 */
export function LabelBuilder({
  slug,
  orderId,
  boxes,
  contentsTenthOz,
  shopNote,
  paidCents = null,
}: {
  slug: string;
  orderId: string;
  /** The usual box first. */
  boxes: BoxChoice[];
  /** What the shop says the items weigh, in tenths of an ounce. */
  contentsTenthOz: number | null;
  /** One line on what happens in the shop once the label is bought. */
  shopNote: string;
  /** What the shopper paid for shipping, in cents, to show what's left over. */
  paidCents?: number | null;
}) {
  const startWeight = (box: BoxChoice | undefined) =>
    contentsTenthOz === null
      ? { lb: "", oz: "" }
      : tenthOzToLbOz(contentsTenthOz + (box?.emptyTenthOz ?? 0));
  const [boxId, setBoxId] = useState(boxes[0]?.id ?? CUSTOM);
  const [size, setSize] = useState({ length: "", width: "", height: "" });
  const [weight, setWeight] = useState(() => startWeight(boxes[0]));
  const [weightTyped, setWeightTyped] = useState(false);
  const [rates, setRates] = useState<RateChoice[] | null>(null);
  const [chosen, setChosen] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** Money was spent (or may have been): never offer Buy again on this screen. */
  const [locked, setLocked] = useState(false);
  const [quoting, startQuote] = useTransition();
  const [buying, startBuy] = useTransition();
  const sent = useRef(false);

  // A price belongs to one box and one weight: change either and it's gone.
  const changed = () => {
    setRates(null);
    setChosen("");
    setError(null);
  };
  const pickBox = (id: string) => {
    setBoxId(id);
    if (!weightTyped) setWeight(startWeight(boxes.find((box) => box.id === id)));
    changed();
  };
  const typeWeight = (part: "lb" | "oz", value: string) => {
    setWeight((before) => ({ ...before, [part]: value }));
    setWeightTyped(true);
    changed();
  };

  const quote = () =>
    startQuote(async () => {
      setError(null);
      const result = await getLabelRates(slug, orderId, {
        boxId,
        ...size,
        weightLb: weight.lb,
        weightOz: weight.oz,
      });
      if (result.error || !result.rates) {
        setRates(null);
        setError(result.error ?? "We couldn't get rates. Try again.");
        return;
      }
      setRates(result.rates);
      setChosen(result.rates[0]?.id ?? "");
    });

  const buy = () => {
    // One press, one purchase: the ref closes the gap before the button greys out.
    if (sent.current || locked || !chosen) return;
    sent.current = true;
    startBuy(async () => {
      setError(null);
      const result = await buyLabel(slug, orderId, chosen);
      // On success the page moves on to the finished label; there is no
      // result, and the button stays shut.
      if (!result) return;
      if (result.bought) {
        setLocked(true);
        setRates(null);
      } else {
        sent.current = false;
      }
      setError(result.error ?? "Something went wrong. Reload this page before trying again.");
    });
  };

  const busy = quoting || buying;
  const picked = boxes.find((box) => box.id === boxId);

  return (
    <div className="flex flex-col gap-4">
      <fieldset disabled={busy || locked} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="label-box">Box</Label>
            <Select id="label-box" value={boxId} onChange={(event) => pickBox(event.target.value)}>
              {boxes.map((box) => (
                <option key={box.id} value={box.id}>
                  {box.name} ({box.size})
                </option>
              ))}
              <option value={CUSTOM}>Another size…</option>
            </Select>
            {picked && picked.emptyTenthOz > 0 && !weightTyped && contentsTenthOz !== null && (
              <span className="text-muted-foreground text-xs">The weight includes this box.</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs leading-tight font-semibold">Packed weight</span>
            <div className="flex items-center gap-2">
              <Input
                aria-label="Pounds"
                inputMode="decimal"
                className="w-20"
                value={weight.lb}
                onChange={(event) => typeWeight("lb", event.target.value)}
              />
              <span className="text-sm">lb</span>
              <Input
                aria-label="Ounces"
                inputMode="decimal"
                className="w-20"
                value={weight.oz}
                onChange={(event) => typeWeight("oz", event.target.value)}
              />
              <span className="text-sm">oz</span>
            </div>
            {contentsTenthOz === null && (
              <span className="text-muted-foreground text-xs">
                Your shop didn&apos;t give a weight for this order, so pop it on the scale.
              </span>
            )}
          </div>
        </div>
        {boxId === CUSTOM && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs leading-tight font-semibold">Size in inches</span>
            <div className="flex items-center gap-2">
              {(["length", "width", "height"] as const).map((side, index) => (
                <span key={side} className="flex items-center gap-2">
                  {index > 0 && <span className="text-muted-foreground text-sm">×</span>}
                  <Input
                    aria-label={side[0].toUpperCase() + side.slice(1)}
                    placeholder={side[0].toUpperCase() + side.slice(1)}
                    inputMode="decimal"
                    className="w-24"
                    value={size[side]}
                    onChange={(event) => {
                      setSize((before) => ({ ...before, [side]: event.target.value }));
                      changed();
                    }}
                  />
                </span>
              ))}
            </div>
          </div>
        )}
      </fieldset>

      {rates && !locked && (
        <fieldset disabled={busy} className="flex flex-col gap-2">
          <legend className="mb-1 text-xs leading-tight font-semibold">
            Choose a service, cheapest first
          </legend>
          <ul className="divide-border border-border flex flex-col divide-y rounded-md border">
            {rates.map((rate) => (
              <li key={rate.id}>
                <label className="hover:bg-hover flex cursor-pointer items-center gap-3 px-3 py-2 text-sm">
                  <input
                    type="radio"
                    name="label-rate"
                    value={rate.id}
                    checked={chosen === rate.id}
                    onChange={() => setChosen(rate.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{rate.name}</span>
                    {rate.days !== null && (
                      <span className="text-muted-foreground"> · {deliveryDays(rate.days)}</span>
                    )}
                  </span>
                  <span className="text-right font-semibold tabular-nums">
                    {formatPrice(rate.price, rate.currency)}
                    <Margin paidCents={paidCents} price={rate.price} currency={rate.currency} />
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">{shopNote}</p>
        </fieldset>
      )}

      <FormMessage>{error}</FormMessage>

      {!locked && (
        <div className="flex flex-wrap gap-2">
          {rates ? (
            <>
              <Button type="button" onClick={buy} disabled={busy || !chosen} aria-disabled={busy}>
                {buying ? "Buying your label…" : "Buy & print label"}
              </Button>
              <Button type="button" variant="ghost" onClick={quote} disabled={busy}>
                {quoting ? "Checking…" : "Refresh rates"}
              </Button>
            </>
          ) : (
            <Button type="button" variant="outline" onClick={quote} disabled={busy}>
              {quoting ? "Asking the carriers…" : "Get rates"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** "Finish recording" for a label that was paid for but isn't a parcel yet. */
export function FinishLabelButton({
  slug,
  quoteId,
  unsure,
}: {
  slug: string;
  quoteId: string;
  /** We never heard back from EasyPost, so the first step is to ask. */
  unsure: boolean;
}) {
  const [state, action] = useActionState(finishLabel.bind(null, slug, quoteId), {});
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <SubmitButton
        variant="outline"
        size="sm"
        pendingText={unsure ? "Asking EasyPost…" : "Recording…"}
      >
        {unsure ? "Check this label" : "Finish recording"}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
