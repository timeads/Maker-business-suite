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
import {
  allPacked,
  boxPackLines,
  isItemCode,
  nextBox,
  scanItem,
  type PackLine,
} from "@/lib/shipping/scan";
import { looksLikeSlip, parseSlipCode } from "@/lib/shipping/slip-boxes";
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
  /** Every line of the order, whatever is left of it: a box is packed from what goes in the box. */
  items?: PackLine[];
  /** The boxes it goes out in, when there are two or more with something in them. */
  boxes?: PackBox[];
  /** The box whose slip was scanned ("1042/B2"); null for the order's own slip. */
  boxAsked?: number | null;
  /** Its label is already bought: the parcel, each box's label to open, and which were printed. */
  shipment?: { id: string; links: (string | null)[]; printed: number[] } | null;
};

/** One box of an order going out in several. */
export type PackBox = {
  /** What its slip calls it, counting from 1. */
  n: number;
  of: number;
  /** Where its label sits among the purchase's labels, counting from 1. */
  label: number;
  name: string | null;
  tracking: string | null;
  /** Units of each line in this box, by line id. */
  items: Record<string, number>;
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
  problem = null,
  canWrite,
  parcel,
  labels = false,
}: {
  slug: string;
  order: PackOrder | null;
  /** A code that didn't open anything. */
  missing: string | null;
  /** The code was read, but can't be packed as scanned (a box the order no longer has): why. */
  problem?: string | null;
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
  const scanBox = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  /** What has been checked, box by box: 0 is the order packed as a whole. */
  const [packedBy, setPackedBy] = useState<Record<number, Record<string, number>>>({});
  /** The label bought at this bench, until the page reads it back from the parcel. */
  const [boughtHere, setBoughtHere] = useState<{
    id: string;
    links: (string | null)[];
    printed: number[];
    /** The box it was bought for: only that box's label prints by itself. */
    box: number;
  } | null>(null);
  /** Boxes whose label went to a printer from here. */
  const [printedHere, setPrintedHere] = useState<number[]>([]);
  /** The boxes as last seen, in case the page can't read them back once the label is bought. */
  const [keptBoxes, setKeptBoxes] = useState<PackBox[]>([]);
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
        scanBox.current?.focus();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!editable(event.target)) scanBox.current?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  // A split order scanned by a box's slip packs that box; by its own number (an older slip), the whole order.
  const seenBoxes = order?.boxes ?? [];
  if (seenBoxes.length > 0 && keptBoxes !== seenBoxes) setKeptBoxes(seenBoxes);
  // Only once a label was bought right here: until then the page's own reading is the truth.
  const boxes = seenBoxes.length > 0 || !boughtHere ? seenBoxes : keptBoxes;
  const asked = order?.boxAsked ?? null;
  const box = asked === null ? null : (boxes.find((each) => each.n === asked) ?? null);
  const key = box?.n ?? 0;
  const packed = packedBy[key] ?? {};
  const setPacked = (
    next: Record<string, number> | ((before: Record<string, number>) => Record<string, number>),
  ) =>
    setPackedBy((before) => ({
      ...before,
      [key]: typeof next === "function" ? next(before[key] ?? {}) : next,
    }));
  const lines = !order
    ? []
    : box
      ? boxPackLines(order.items ?? order.lines, box)
      : order.lines.filter((line) => line.left > 0);
  const done = order ? allPacked(lines, packed) : false;
  const boxDone = (each: PackBox) =>
    allPacked(boxPackLines(order?.items ?? [], each), packedBy[each.n] ?? {});
  /** Everything going out is checked: every box, or the whole order. */
  const allDone = box ? boxes.every(boxDone) : done;
  const shipment = order?.shipment ?? boughtHere;
  const printed = [...new Set([...(order?.shipment?.printed ?? []), ...printedHere])];
  const toPrint = nextBox(boxes, printed);
  const count = (line: PackLine) => packed[line.line_id] ?? 0;
  const unitsLeft = lines.reduce((sum, line) => sum + line.left, 0);
  const unitsPacked = lines.reduce((sum, line) => sum + Math.min(count(line), line.left), 0);
  const what = order ? (box ? `box ${box.n} of ${order.name}` : order.name) : "";

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
    scanBox.current?.focus();
    if (!typed) return;
    // Another slip (the next box's, or the next order's) opens it; anything else is an item.
    const everyLine = order?.items ?? order?.lines ?? [];
    if (!order || finished || (looksLikeSlip(typed, order.name) && !isItemCode(everyLine, typed))) {
      const wanted = parseSlipCode(typed);
      if (!wanted) return say(false, `“${typed}” doesn't look like an order number.`);
      setSaid(null);
      // The code as scanned: the page reads which order, and which box of it.
      router.push(`${base}/scan?code=${encodeURIComponent(typed.replace(/^#+/, "").trim())}`);
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
        result.done ? `That's everything for ${what}.` : `Packed 1 × ${result.title}.`,
      );
    }
    if (result.reason === "full") {
      return say(
        false,
        `You've already packed all ${result.left} × ${result.title}. This one is extra.`,
      );
    }
    const elsewhere = box ? everyLine.find((line) => isItemCode([line], typed)) : undefined;
    say(
      false,
      elsewhere
        ? `${elsewhere.title} goes in another box, not box ${box!.n}.`
        : `“${typed}” isn't on ${order.name}. Check the item, or choose “Different order” to start another.`,
    );
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)] xl:items-start">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-5">
          <form onSubmit={onScan} className="flex flex-col gap-1.5">
            <Label htmlFor="scan-box">
              {order && !finished ? `Scan the items for ${what}` : "Scanner"}
            </Label>
            <Input
              id="scan-box"
              ref={scanBox}
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
            {!said && !order && problem && (
              <p
                role="alert"
                className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm font-semibold"
              >
                {problem}
              </p>
            )}
            {!said && !order && !problem && missing && (
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
                {box && (
                  <Badge tone="open">
                    Box {box.n} of {box.of}
                  </Badge>
                )}
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
              {box && (
                <div className="flex flex-col gap-2">
                  <ul className="flex flex-wrap items-center gap-1.5" aria-label="Boxes">
                    {boxes.map((each) => (
                      <li key={each.n}>
                        <Badge tone={boxDone(each) ? "good" : each.n === box.n ? "open" : "closed"}>
                          Box {each.n}
                          {each.name ? ` · ${each.name}` : ""}
                          {each.n === box.n && !boxDone(each) ? " · packing now" : ""}
                          {boxDone(each) ? " · packed" : ""}
                          {printed.includes(each.n) ? " · label printed" : ""}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                  {done && (
                    <p
                      role="status"
                      className="bg-mint-soft text-mint-ink rounded-md px-3 py-2 text-sm"
                    >
                      Box {box.n} of {box.of} is packed.{" "}
                      {printed.includes(box.n)
                        ? toPrint
                          ? `Its label is printed. Scan the packing slip for box ${toPrint.n}.`
                          : "Its label is printed. That's every box."
                        : "Print its label below."}
                    </p>
                  )}
                  {box.tracking && (
                    <p className="text-muted-foreground text-xs tabular-nums">
                      Tracking for this box: {box.tracking}
                    </p>
                  )}
                </div>
              )}
              {!box && boxes.length > 1 && !order.closed && lines.length > 0 && (
                <p className="text-muted-foreground text-xs">
                  This order is planned in {boxes.length} boxes. You&apos;re packing it as a whole;
                  scan one box&apos;s slip to check that box on its own.
                </p>
              )}
              {lines.length === 0 ? (
                <p className="text-sm">
                  {box
                    ? `Nothing on file goes in box ${box.n}. Its boxes may have changed: print the packing slips again.`
                    : (order.closed ?? "Everything on this order has already been sent.")}
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
                      {unitsPacked} of {unitsLeft} packed{box ? ` in box ${box.n}` : ""}
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
                        {box ? `Mark all of box ${box.n} packed` : "Mark all packed"}
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

          {allDone && canWrite && !order.held && order.pickup && (
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
          {box && shipment && done && (
            <Card>
              <CardHeader>
                <CardTitle>
                  Box {box.n} of {box.of}: its label
                </CardTitle>
                <CardDescription>
                  The labels for every box of {order.name} are bought. This is box {box.n}&apos;s
                  {box.tracking ? ` (${box.tracking})` : ""}. Stick it on, then scan the next slip.
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <LabelPrint
                  key={box.n}
                  slug={slug}
                  shipmentId={shipment.id}
                  box={{ n: box.n, label: box.label }}
                  links={
                    shipment.links[box.n - 1]
                      ? [{ href: shipment.links[box.n - 1]!, text: `Print box ${box.n} label` }]
                      : []
                  }
                  printedAt={printed.includes(box.n) ? "printed" : null}
                  printedText={null}
                  // Bought a moment ago for this very box: its label comes out by itself.
                  auto={
                    boughtHere?.id === shipment.id &&
                    boughtHere.box === box.n &&
                    !printed.includes(box.n)
                  }
                  primary
                  onPrinted={() => {
                    const now = [...new Set([...printed, box.n])];
                    setPrintedHere((before) => [...new Set([...before, box.n])]);
                    // Every box labelled: the next scan is the next order's slip.
                    if (!nextBox(boxes, now)) setFinished(true);
                    scanBox.current?.focus();
                  }}
                />
                {toPrint && toPrint.n !== box.n && (
                  <span className="text-muted-foreground text-xs">
                    Next: scan the packing slip for box {toPrint.n}.
                  </span>
                )}
              </CardContent>
            </Card>
          )}
          {(box ? done && !shipment : done) &&
            canWrite &&
            !order.held &&
            !order.pickup &&
            labels &&
            !order.together &&
            lines.length > 0 && (
              <BenchLabel
                slug={slug}
                orderId={order.id}
                orderName={order.name}
                orderHref={`${base}/orders/${order.id}`}
                nextHref={`${base}/scan`}
                tellsShop={parcel.shopOffered && parcel.shopDefault}
                emailsCustomer={parcel.shopOffered && parcel.shopDefault && parcel.notifyDefault}
                box={box ? { n: box.n, of: box.of } : null}
                onBought={(bought) => {
                  if (box && bought.shipmentId) {
                    // One purchase covers every box; only this box's label prints now.
                    setBoughtHere({
                      box: box.n,
                      id: bought.shipmentId,
                      links: boxes.map((each) => bought.labels[each.label - 1]?.href ?? null),
                      printed: [],
                    });
                    // Read the parcel back: each box's own label and tracking number.
                    router.refresh();
                  } else {
                    setFinished(true);
                  }
                  scanBox.current?.focus();
                }}
              />
            )}
          {allDone &&
            canWrite &&
            !order.held &&
            !order.pickup &&
            !finished &&
            !shipment &&
            lines.length > 0 && (
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
                    lines={order.lines.filter((line) => line.left > 0)}
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
  box = null,
  onBought,
}: {
  slug: string;
  orderId: string;
  /** Packing one box of several: the purchase covers every box, and this box's label prints first. */
  box?: { n: number; of: number } | null;
  orderName: string;
  orderHref: string;
  nextHref: string;
  /** The workspace's settings mark a bought label's order as sent in the shop. */
  tellsShop: boolean;
  emailsCustomer: boolean;
  onBought: (bought: NonNullable<ScanBought["bought"]>) => void;
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
      if (outcome.bought) onBought(outcome.bought);
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

  // One box of several: the bench shows that box's own label card from here on.
  if (bought && box && bought.shipmentId) return null;
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
        <CardTitle>
          {box
            ? `Box ${box.n} of ${box.of} is packed. Buy the labels`
            : "All packed. Buy the label"}
        </CardTitle>
        <CardDescription>
          {offer
            ? box
              ? `One purchase covers all ${box.of} boxes, as your To ship list planned them, priced just now. Box ${box.n}'s label prints now; print each other box's when you've packed it.`
              : "The box, weight and service your To ship list planned for this order, priced just now."
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
                  {buying
                    ? "Buying…"
                    : box
                      ? `Buy ${box.of} labels & print box ${box.n}`
                      : "Buy & print label"}
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
