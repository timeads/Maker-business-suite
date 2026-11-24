"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { formatPrice } from "@/lib/shipping/easypost";
import { allPacked, orderCode, scanItem, type PackLine } from "@/lib/shipping/scan";
import { printSettings, wantedLabelFormat } from "@/lib/shipping/zebra/settings";
import { cn } from "@/lib/utils";
import { ParcelForm, PickupForm } from "../forms";
import { LabelPrint } from "../print-ui";
import { buyScanLabel, planScanLabel, type ScanBought, type ScanPlan } from "../scan-actions";

export type PackOrder = {
  id: string;
  name: string;
  customer: string;
  place: string;
  chose: string;
  note: string | null;
  lines: PackLine[];
  pickup: boolean;
  pickupReady: boolean;
  /** Why it shouldn't go out yet, in words. */
  held: string | null;
  /** Nothing to pack any more: cancelled or collected. */
  closed: string | null;
  unpaid: boolean;
  /** It goes out in one parcel with other orders: the label is bought for them all, on their page. */
  together?: boolean;
  /** Whether the next pickup step reaches the shop (see `pickupTells`). */
  pickupTells?: "yes" | "no_permission" | "off";
};

type Said = { ok: boolean; text: string } | null;

let audio: AudioContext | undefined;
/** A short high note for a good scan, a longer low one for a wrong one. */
function beep(ok: boolean) {
  try {
    audio ??= new AudioContext();
    const tone = audio.createOscillator();
    const gain = audio.createGain();
    tone.frequency.value = ok ? 880 : 220;
    gain.gain.value = 0.08;
    tone.connect(gain).connect(audio.destination);
    tone.start();
    tone.stop(audio.currentTime + (ok ? 0.08 : 0.3));
  } catch {
    // No sound on this device; the words on screen say the same.
  }
}

/**
 * The packing bench. A scanner types its code and presses Enter, so the box
 * at the top takes both: first an order number, then each item.
 */
export function PackStation({
  slug,
  order,
  missing,
  canWrite,
  parcel,
  labels = false,
}: {
  slug: string;
  order: PackOrder | null;
  /** A code that didn't open anything. */
  missing: string | null;
  canWrite: boolean;
  parcel: {
    defaultCarrier: string;
    shopOffered: boolean;
    shopDefault: boolean;
    notifyDefault: boolean;
    currency: string;
  };
  /** A postage account is connected, so the planned label can be bought right here. */
  labels?: boolean;
}) {
  const router = useRouter();
  const base = `/w/${slug}/shipping`;
  const box = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [packed, setPacked] = useState<Record<string, number>>({});
  const [said, setSaid] = useState<Said>(null);
  /** The label is bought and the parcel recorded: the next scan is the next order's slip. */
  const [finished, setFinished] = useState(false);

  // Scanners don't click: keep the box ready whatever was pressed last.
  useEffect(() => {
    const editable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      Boolean(target.closest("input, textarea, select, [contenteditable]"));
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      if (!event.target.closest("button, a, input, select, textarea, summary, label")) {
        box.current?.focus();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!editable(event.target)) box.current?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const lines = order ? order.lines.filter((line) => line.left > 0) : [];
  const done = order ? allPacked(lines, packed) : false;
  const count = (line: PackLine) => packed[line.line_id] ?? 0;
  const unitsLeft = lines.reduce((sum, line) => sum + line.left, 0);
  const unitsPacked = lines.reduce((sum, line) => sum + Math.min(count(line), line.left), 0);

  const say = (ok: boolean, text: string) => {
    beep(ok);
    setSaid({ ok, text });
  };
  const bump = (line: PackLine, by: number) =>
    setPacked((before) => ({
      ...before,
      [line.line_id]: Math.max(0, Math.min(line.left, (before[line.line_id] ?? 0) + by)),
    }));

  function onScan(event: React.FormEvent) {
    event.preventDefault();
    const typed = code.trim();
    setCode("");
    box.current?.focus();
    if (!typed) return;
    if (!order || finished) {
      const wanted = orderCode(typed);
      if (!wanted) return say(false, `“${typed}” doesn't look like an order number.`);
      setSaid(null);
      router.push(`${base}/scan?code=${encodeURIComponent(wanted)}`);
      return;
    }
    const result = scanItem(lines, packed, typed);
    if (result.ok) {
      setPacked((before) => ({
        ...before,
        [result.line_id]: (before[result.line_id] ?? 0) + 1,
      }));
      return say(
        true,
        result.done ? `That's everything for ${order.name}.` : `Packed 1 × ${result.title}.`,
      );
    }
    if (result.reason === "full") {
      return say(
        false,
        `You've already packed all ${result.left} × ${result.title}. This one is extra.`,
      );
    }
    say(
      false,
      `“${typed}” isn't on ${order.name}. Check the item, or choose “Different order” to start another.`,
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <form onSubmit={onScan} className="flex flex-col gap-1.5">
            <Label htmlFor="scan-box">
              {order && !finished ? `Scan the items for ${order.name}` : "Scanner"}
            </Label>
            <Input
              id="scan-box"
              ref={box}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoFocus
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              maxLength={80}
              className="h-12 text-lg"
              placeholder={
                order && !finished
                  ? "Scan an item, or type its code"
                  : "Scan a packing slip, or type an order number"
              }
            />
          </form>
          <p className="text-muted-foreground text-xs">
            A barcode scanner types into this box and presses Enter for you. Scan the slip first,
            then each item. Typing works just as well.
          </p>
          <div aria-live="assertive" className="min-h-10">
            {said && (
              <p
                role={said.ok ? "status" : "alert"}
                className={cn(
                  "rounded-lg border px-3 py-2 text-sm font-semibold",
                  said.ok
                    ? "border-mint-ink/15 bg-mint-soft text-mint-ink"
                    : "border-brick/25 bg-brick-soft text-brick",
                )}
              >
                {said.text}
              </p>
            )}
            {!said && !order && missing && (
              <p
                role="alert"
                className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm font-semibold"
              >
                No order numbered “{missing}” here. Check the number and try again.
              </p>
            )}
          </div>
          {order && (
            <Button asChild variant="outline" size="sm" className="w-fit">
              <Link href={`${base}/scan`}>Different order</Link>
            </Button>
          )}
        </CardContent>
      </Card>

      {order && (
        <div className="flex min-w-0 flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-2">
                <Link href={`${base}/orders/${order.id}`} className="hover:underline">
                  {order.name}
                </Link>
                <span className="font-read font-normal">· {order.customer}</span>
                {order.pickup && <Badge tone="open">Pickup</Badge>}
                {order.unpaid && <Badge tone="waiting">Payment pending</Badge>}
                {order.held && <Badge tone="bad">On hold</Badge>}
              </CardTitle>
              <CardDescription>
                {[order.place, order.chose].filter(Boolean).join(" · ")}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {order.held && (
                <p className="bg-brick-soft text-brick rounded-md px-3 py-2 text-sm">
                  {order.held}{" "}
                  <Link href={`${base}/orders/${order.id}`} className="font-semibold underline">
                    Release it on the order
                  </Link>{" "}
                  before it goes out.
                </p>
              )}
              {order.note && (
                <p className="bg-note font-read rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
                  {order.note}
                </p>
              )}
              {lines.length === 0 ? (
                <p className="text-sm">
                  {order.closed ?? "Everything on this order has already been sent."}
                </p>
              ) : (
                <>
                  <ul className="divide-border flex flex-col divide-y">
                    {lines.map((line) => {
                      const full = count(line) >= line.left;
                      return (
                        <li key={line.line_id} className="flex items-center gap-3 py-2.5">
                          <span
                            className={cn(
                              "flex size-11 shrink-0 items-center justify-center rounded-md text-sm font-bold tabular-nums",
                              full ? "bg-mint-soft text-mint-ink" : "bg-sunken",
                            )}
                            aria-label={`${count(line)} of ${line.left} packed`}
                          >
                            {full ? (
                              <Check className="size-5" aria-hidden />
                            ) : (
                              `${count(line)}/${line.left}`
                            )}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="font-read block font-semibold">
                              {line.left} × {line.title}
                              {line.variant ? ` (${line.variant})` : ""}
                            </span>
                            <span className="text-muted-foreground block font-mono text-xs">
                              {line.sku ?? line.barcode ?? "No code: tick it by hand"}
                            </span>
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={count(line) === 0}
                            aria-label={`One fewer ${line.title}`}
                            onClick={() => bump(line, -1)}
                          >
                            <Minus />
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={full}
                            aria-label={`Pack one ${line.title}`}
                            onClick={() => bump(line, 1)}
                          >
                            <Plus />
                          </Button>
                        </li>
                      );
                    })}
                  </ul>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums">
                      {unitsPacked} of {unitsLeft} packed
                    </span>
                    {!done && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          setPacked(
                            Object.fromEntries(lines.map((line) => [line.line_id, line.left])),
                          )
                        }
                      >
                        Mark all packed
                      </Button>
                    )}
                    {unitsPacked > 0 && (
                      <Button variant="ghost" size="sm" onClick={() => setPacked({})}>
                        Start again
                      </Button>
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          {done && canWrite && !order.held && order.pickup && (
            <Card>
              <CardHeader>
                <CardTitle>Packed. Nothing to post</CardTitle>
                <CardDescription>
                  {order.pickupReady
                    ? "It's already marked ready for pickup."
                    : "They're collecting this one. Mark it ready so the team knows it's waiting."}
                </CardDescription>
              </CardHeader>
              {!order.pickupReady && (
                <CardContent>
                  <PickupForm
                    slug={slug}
                    orderId={order.id}
                    ready={false}
                    pickedUp={false}
                    canUndo={false}
                    tells={order.pickupTells}
                  />
                </CardContent>
              )}
            </Card>
          )}
          {done && canWrite && !order.held && !order.pickup && labels && !order.together && (
            <BenchLabel
              slug={slug}
              orderId={order.id}
              orderName={order.name}
              orderHref={`${base}/orders/${order.id}`}
              nextHref={`${base}/scan`}
              tellsShop={parcel.shopOffered && parcel.shopDefault}
              emailsCustomer={parcel.shopOffered && parcel.shopDefault && parcel.notifyDefault}
              onBought={() => {
                setFinished(true);
                box.current?.focus();
              }}
            />
          )}
          {done && canWrite && !order.held && !order.pickup && !finished && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {labels && !order.together
                    ? "Or record a parcel by hand"
                    : "All packed. Record the parcel"}
                </CardTitle>
                <CardDescription>
                  {labels && order.together
                    ? "This order is going out with others on one label: open them together (above) to buy it. Recording a parcel here sends this order on its own."
                    : labels
                      ? "Bought the postage somewhere else? Scan or paste its tracking number."
                      : "Buy the postage wherever you usually do, then scan or paste the tracking number."}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ParcelForm
                  slug={slug}
                  orderId={order.id}
                  lines={lines}
                  backTo="scan"
                  quiet={labels && !order.together}
                  {...parcel}
                />
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Every item is checked: the planned label, offered right here. It is the
 * plan the To ship list shows (box, weight, service), priced afresh, and
 * bought through the same server path as the order page. An order that
 * can't be planned says why and points at its own page.
 */
function BenchLabel({
  slug,
  orderId,
  orderName,
  orderHref,
  nextHref,
  tellsShop,
  emailsCustomer,
  onBought,
}: {
  slug: string;
  orderId: string;
  orderName: string;
  orderHref: string;
  nextHref: string;
  /** The workspace's settings mark a bought label's order as sent in the shop. */
  tellsShop: boolean;
  emailsCustomer: boolean;
  onBought: () => void;
}) {
  const [plan, setPlan] = useState<ScanPlan | null>(null);
  const [result, setResult] = useState<ScanBought | null>(null);
  const [buying, startBuy] = useTransition();
  const asked = useRef(false);
  const pressed = useRef(false);

  // Asked once, when the last item is checked. Asking buys nothing.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    void planScanLabel(slug, orderId, wantedLabelFormat(printSettings()))
      .then(setPlan)
      .catch(() => setPlan({ why: "We couldn't reach the carriers just now." }));
  }, [slug, orderId]);

  const offer = plan?.offer;
  const bought = result?.bought;
  const buy = () => {
    // One press, one purchase.
    if (!offer || pressed.current) return;
    pressed.current = true;
    startBuy(async () => {
      const outcome = await buyScanLabel(
        slug,
        orderId,
        offer.rateId,
        wantedLabelFormat(printSettings()),
      ).catch((): ScanBought => ({
        unsure: true,
        error:
          "We lost touch part-way through, so we can't tell whether this label was bought. Please don't buy another. Open the order to check.",
      }));
      setResult(outcome);
      if (outcome.bought) onBought();
      // A plain "no" bought nothing, so the button comes back. Anything else stays locked.
      else if (!outcome.unsure) pressed.current = false;
    });
  };
  const refresh = () => {
    setResult(null);
    setPlan(null);
    void planScanLabel(slug, orderId, wantedLabelFormat(printSettings()))
      .then(setPlan)
      .catch(() => setPlan({ why: "We couldn't reach the carriers just now." }));
  };

  if (bought) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Label bought for {orderName}</CardTitle>
          <CardDescription>
            Parcel {bought.number} · {bought.service} · {formatPrice(bought.price, bought.currency)}
            . Stick it on, then scan the next slip.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {bought.shipmentId ? (
            <LabelPrint
              slug={slug}
              shipmentId={bought.shipmentId}
              links={bought.labels.map((label) => ({
                href: label.href,
                text: `Print ${label.text.toLowerCase()}`,
              }))}
              printedAt={null}
              printedText={null}
              auto
              primary
            />
          ) : (
            <Link href={orderHref} className="text-ochre-text text-sm font-medium hover:underline">
              Open the order to print its label
            </Link>
          )}
          <Button asChild variant="outline" size="sm">
            <Link href={nextHref}>Next order</Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>All packed. Buy the label</CardTitle>
        <CardDescription>
          {offer
            ? "The box, weight and service your To ship list planned for this order, priced just now."
            : plan
              ? "This one needs a look before a label is bought."
              : "Asking the carriers for a price…"}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {offer && (
          <>
            <p className="text-sm">
              <span className="font-semibold">{offer.service}</span> ·{" "}
              <span className="font-extrabold tabular-nums">
                {formatPrice(offer.price, offer.currency)}
              </span>
              {offer.days ? ` · about ${offer.days} ${offer.days === 1 ? "day" : "days"}` : ""}
              <span className="text-muted-foreground block text-xs">
                {offer.packing}
                {offer.signature ? " · signature on delivery" : ""}
                {tellsShop
                  ? emailsCustomer
                    ? " · your shop is told, and emails the customer their tracking"
                    : " · your shop is told it's sent"
                  : ""}
              </span>
            </p>
            {!result?.unsure && (
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" onClick={buy} disabled={buying}>
                  {buying ? "Buying…" : "Buy & print label"}
                </Button>
                <Link
                  href={orderHref}
                  className="text-ochre-text text-sm font-medium hover:underline"
                >
                  Change the box or service
                </Link>
              </div>
            )}
          </>
        )}
        {plan?.why && (
          <p className="text-sm">
            {plan.why}{" "}
            <Link href={orderHref} className="text-ochre-text font-medium hover:underline">
              Open the order
            </Link>{" "}
            to sort it out and buy the label there.
          </p>
        )}
        {result?.error && (
          <p
            role="alert"
            className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm"
          >
            {result.error}{" "}
            {result.unsure ? (
              <Link href={orderHref} className="font-semibold underline">
                Open the order
              </Link>
            ) : (
              <button type="button" className="font-semibold underline" onClick={refresh}>
                Get the price again
              </button>
            )}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
