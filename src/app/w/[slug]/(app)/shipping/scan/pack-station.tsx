"use client";

import { useCallback, useEffect, useEffectEvent, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Package, Plus, Printer, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { formatPrice } from "@/lib/shipping/easypost";
import {
  BENCH_MAX_BOXES,
  addSplitBox,
  allPacked,
  autoPrintNow,
  benchSplitChoice,
  keepScanned,
  notBoxed,
  removeSplitBox,
  sameSplit,
  setSplitQty,
  splitEvenly,
  type BenchSplitBox,
  benchMargin,
  boxPackLines,
  isItemCode,
  nextBox,
  notScanned,
  partQuery,
  scanItem,
  scannedPart,
  type BenchBox,
  type PackLine,
} from "@/lib/shipping/scan";
import { looksLikeSlip, parseSlipCode } from "@/lib/shipping/slip-boxes";
import { printSettings, wantedLabelFormat } from "@/lib/shipping/zebra/settings";
import { usePrintSettings } from "@/lib/shipping/zebra/use-print-settings";
import { cn } from "@/lib/utils";
import { releaseOrders } from "../actions";
import { ParcelForm, PickupForm } from "../forms";
import { LabelPrint, SlipsButton } from "../print-ui";
import {
  buyScanLabel,
  planScanLabel,
  saveBenchBoxes,
  type ScanBought,
  type ScanPlan,
} from "../scan-actions";

export type PackOrder = {
  id: string;
  name: string;
  customer: string;
  place: string;
  chose: string;
  /** "paid $33.00", "free shipping", or null when it isn't known (or it's being collected). */
  paid: string | null;
  paidAmount: number | null;
  note: string | null;
  lines: PackLine[];
  pickup: boolean;
  pickupReady: boolean;
  /** Why it shouldn't go out yet, in words. */
  held: string | null;
  /** Nothing to pack any more: cancelled or collected. */
  closed: string | null;
  unpaid: boolean;
  /** Everything on it has gone: the lines are there to check a box against its slip, nothing more. */
  hasLabel: boolean;
  /** A label for it is part-way bought; it is finished on the order's own page. */
  labelOpen: boolean;
  /** It goes out in one parcel with other orders: every order's items are on the bench, oldest first. */
  together: { ids: string[]; names: string[] } | null;
  /** The order's own page (or the group's), where boxes, service and address can be changed. */
  builderHref: string;
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

/** A box the workspace packs in, for the bench's box row. */
export type BenchSavedBox = {
  id: string;
  name: string;
  length: string;
  width: string;
  height: string;
};

type Said = { ok: boolean; text: string } | null;
type Bought = NonNullable<ScanBought["bought"]>;
/** What the bench shows once a label is bought and the parcel recorded. */
type Finished = {
  bought: Bought;
  /** Only what was scanned went: what is still to send, and whether it waits on hold. */
  part: { left: string[]; held: boolean } | null;
};

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

const notice = "rounded-md px-3.5 py-2.5 text-sm";

/**
 * The packing bench. A scanner types its code and presses Enter, so the box
 * at the top takes both: first a packing slip, then each item. Whatever is
 * pressed, the keyboard goes back to that box.
 */
export function PackStation({
  slug,
  order,
  missing,
  problem = null,
  canWrite,
  parcel,
  labels = false,
  boxes: savedBoxes = [],
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
  /** The boxes the workspace packs in, the usual one first. */
  boxes?: BenchSavedBox[];
}) {
  const router = useRouter();
  const base = `/w/${slug}/shipping`;
  const scanBox = useRef<HTMLInputElement>(null);
  const [settings, saveSettings] = usePrintSettings();
  const [code, setCode] = useState("");
  /** What has been checked, box by box: 0 is the order packed as a whole. */
  const [packedBy, setPackedBy] = useState<Record<number, Record<string, number>>>({});
  /** A count was filled in by hand: the order no longer counts as checked with the scanner. */
  const [byHand, setByHand] = useState(false);
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
  const [finished, setFinished] = useState<Finished | null>(null);
  /** Every box's label has been printed. */
  const [boxesDone, setBoxesDone] = useState(false);
  /** A person said to send this one before it is paid for (net 30, an invoice). */
  const [payOk, setPayOk] = useState(false);
  /** The hold was lifted here, a moment before the page reads it back. */
  const [released, setReleased] = useState(false);
  const [releasing, startRelease] = useTransition();
  /** Counts up when the finishing scan should press the button by itself. */
  const [autoGo, setAutoGo] = useState(0);
  /** The box whose label should print by itself, its last item just scanned. */
  const [autoBox, setAutoBox] = useState<number | null>(null);
  /** Counts the times this order was started afresh here (the rest of a part shipment). */
  const [round, setRound] = useState(0);
  /** The split was changed here: the box slips printed before no longer match. */
  const [resplit, setResplit] = useState(false);

  const focus = useCallback(() => {
    window.setTimeout(() => scanBox.current?.focus(), 0);
  }, []);

  // Scanners don't click: the box takes the keyboard back whatever was pressed last.
  useEffect(() => {
    const typing = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      Boolean(target.closest("input, textarea, select, [contenteditable], dialog"));
    const onClick = (event: MouseEvent) => {
      if (!typing(event.target)) focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!typing(event.target)) scanBox.current?.focus();
    };
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [focus]);

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
  const shipment = order?.shipment ?? boughtHere;
  const printed = [...new Set([...(order?.shipment?.printed ?? []), ...printedHere])];
  const toPrint = nextBox(boxes, printed);
  const count = (line: PackLine) => packed[line.line_id] ?? 0;
  const unitsLeft = lines.reduce((sum, line) => sum + line.left, 0);
  const unitsPacked = lines.reduce((sum, line) => sum + Math.min(count(line), line.left), 0);
  const what = order ? (box ? `box ${box.n} of ${order.name}` : order.name) : "";
  const held = order?.held && !released ? order.held : null;

  /** Why nothing can be bought for it as it stands; null when the bench can go ahead. */
  const blocked = !order
    ? null
    : order.closed
      ? order.closed
      : order.hasLabel && !(box && shipment)
        ? "This order already has a label."
        : order.labelOpen
          ? "A label for this order is part-way bought. Open the label builder to finish it."
          : held
            ? held
            : order.unpaid && !payOk
              ? "Payment is still pending."
              : null;

  const say = (ok: boolean, text: string) => {
    beep(ok);
    setSaid({ ok, text });
  };
  const fill = (line: PackLine, to: number) => {
    setByHand(true);
    setPacked((before) => ({ ...before, [line.line_id]: Math.max(0, Math.min(line.left, to)) }));
  };

  function onScan(event: React.FormEvent) {
    event.preventDefault();
    const typed = code.trim();
    setCode("");
    scanBox.current?.focus();
    if (!typed) return;
    // Another slip (the next box's, or the next order's) opens it; anything else is an item.
    const everyLine = order?.items?.length
      ? [...order.items, ...order.lines]
      : (order?.lines ?? []);
    if (
      !order ||
      finished ||
      boxesDone ||
      (looksLikeSlip(typed, order.name) && !isItemCode(everyLine, typed))
    ) {
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
      // With the box ticked on this computer, the scan that finishes it presses print.
      const auto = autoPrintNow({
        ticked: settings.autoPrint,
        verified: result.done,
        byHand,
        blocked: Boolean(blocked) || !canWrite || order.pickup || !labels,
      });
      if (auto && box && shipment) {
        if (!printed.includes(box.n)) setAutoBox(box.n);
        return say(true, `Box ${box.n} scanned. Printing its label.`);
      }
      if (auto && !shipment) {
        setAutoGo((n) => n + 1);
        return say(
          true,
          box
            ? `Box ${box.n} scanned. Printing its label.`
            : `All scanned. Printing the label for ${order.name}.`,
        );
      }
      return say(
        true,
        result.done ? `That's everything for ${what}.` : `Packed 1 × ${result.title}.`,
      );
    }
    if (result.reason === "full") {
      return say(
        false,
        `Already scanned all ${result.left} × ${result.title}${box ? ` for box ${box.n}` : ""}.`,
      );
    }
    const elsewhere = box ? everyLine.find((line) => isItemCode([line], typed)) : undefined;
    say(
      false,
      elsewhere
        ? `${elsewhere.title} goes in another box, not box ${box!.n}.`
        : `${typed} isn't in ${order.name}.`,
    );
  }

  const canBuy =
    Boolean(order) &&
    canWrite &&
    labels &&
    !blocked &&
    !order!.pickup &&
    !shipment &&
    !finished &&
    lines.length > 0;

  return (
    <div className="grid max-w-[900px] gap-4">
      <Card>
        <CardContent className="flex flex-col gap-2 pt-5">
          <form onSubmit={onScan} className="flex flex-col gap-1.5">
            <Label htmlFor="scan-box">Scanner</Label>
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
              className="h-[52px] text-xl tracking-wide"
              placeholder="Scan a packing slip, or type an order number"
            />
          </form>
          <p className="text-muted-foreground text-xs">
            Barcode scanners type into this box and press Enter. Scan the order first, then each
            item.
          </p>
          <label
            className="flex w-fit items-center gap-2 text-xs"
            title="Kept on this computer only"
          >
            <input
              type="checkbox"
              checked={settings.autoPrint}
              onChange={(event) => {
                saveSettings({ autoPrint: event.target.checked });
                setSaid({
                  ok: true,
                  text: event.target.checked
                    ? "Auto-print is on: the label is bought and printed when the last item is scanned."
                    : "Auto-print is off: press Verify & print.",
                });
                focus();
              }}
            />
            <Printer className="size-3.5" aria-hidden />
            Print the label as soon as every item is scanned
          </label>
          <div aria-live="assertive" className="empty:hidden">
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
            {!said && !order && (problem || missing) && (
              <p
                role="alert"
                className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm font-semibold"
              >
                {problem ?? `No order numbered “${missing}” here. Check the number and try again.`}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      {order && finished && (
        <DoneCard
          slug={slug}
          order={order}
          finished={finished}
          onRest={() => {
            // The same order again, with only what is left on it.
            setFinished(null);
            setPackedBy({});
            setByHand(false);
            setRound((n) => n + 1);
            router.push(`${base}/scan?code=${encodeURIComponent(order.name.replace(/^#+/, ""))}`);
            router.refresh();
            focus();
          }}
        />
      )}

      {order && !finished && (
        <Card>
          <CardContent className="flex flex-col gap-3 pt-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex flex-wrap items-center gap-2 text-xl font-bold tabular-nums">
                  {order.name}
                  {box && (
                    <Badge tone="open">
                      Box {box.n} of {box.of}
                    </Badge>
                  )}
                  {order.pickup && <Badge tone="open">Pickup</Badge>}
                </h2>
                <p className="text-muted-foreground text-xs">
                  {[order.customer, order.chose || (order.pickup ? "Collecting" : ""), order.paid]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={order.builderHref}>Open label builder</Link>
              </Button>
            </div>

            {blocked && (
              <p
                role="status"
                className={cn(notice, "bg-brick-soft text-brick flex flex-wrap items-center gap-3")}
              >
                <span>{blocked}</span>
                {held && canWrite && !order.closed && !order.hasLabel && !order.labelOpen && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={releasing}
                    onClick={() =>
                      startRelease(async () => {
                        const result = await releaseOrders(slug, [order.id]).catch(() => ({
                          error: "That didn't save. Please try again.",
                        }));
                        if ("error" in result && result.error) return say(false, result.error);
                        setReleased(true);
                        say(true, `${order.name} released. Pack the rest.`);
                        router.refresh();
                      })
                    }
                  >
                    {releasing ? "Releasing…" : "Release hold"}
                  </Button>
                )}
                {!held &&
                  order.unpaid &&
                  !payOk &&
                  canWrite &&
                  !order.closed &&
                  !order.hasLabel &&
                  !order.labelOpen && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        if (
                          window.confirm(
                            `${order.name} hasn't been paid yet. Ship it anyway (net 30 or invoiced, say)?`,
                          )
                        ) {
                          setPayOk(true);
                        }
                      }}
                    >
                      Ship before payment
                    </Button>
                  )}
              </p>
            )}
            {order.together && !blocked && (
              <p role="status" className={cn(notice, "bg-note")}>
                {order.together.names.join(" + ")} are going out together on one label. Every
                order&apos;s items are listed here; the label is bought for them all at once.
              </p>
            )}
            {order.pickup && !blocked && (
              <p role="status" className={cn(notice, "bg-note")}>
                They&apos;re collecting this one, so it needs no label. Check it off, then mark it
                ready.
              </p>
            )}
            {order.note && (
              <p className={cn(notice, "bg-note font-read whitespace-pre-wrap")}>{order.note}</p>
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
                  <p role="status" className={cn(notice, "bg-mint-soft text-mint-ink")}>
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
            {!box && boxes.length > 1 && !order.closed && lines.length > 0 && !order.hasLabel && (
              <p className="text-muted-foreground text-xs">
                This order is planned in {boxes.length} boxes. You&apos;re packing it as a whole;
                scan one box&apos;s slip to check that box on its own.
              </p>
            )}

            {lines.length === 0 ? (
              !order.closed && (
                <p className={cn(notice, "bg-brick-soft text-brick")}>
                  {box
                    ? `Nothing on file goes in box ${box.n}. Its boxes may have changed: print the packing slips again.`
                    : "Everything on this order has already been sent."}
                </p>
              )
            ) : (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {unitsLeft} {unitsLeft === 1 ? "item" : "items"}
                    {box ? ` in box ${box.n}` : ""} · {unitsPacked} packed
                  </span>
                  <span className="flex items-center gap-1.5">
                    {unitsPacked > 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setPacked({});
                          setByHand(false);
                        }}
                      >
                        Start again
                      </Button>
                    )}
                    {!done && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        title="Count every item as packed without scanning each one"
                        onClick={() => {
                          setByHand(true);
                          setPacked(
                            Object.fromEntries(lines.map((line) => [line.line_id, line.left])),
                          );
                          beep(true);
                        }}
                      >
                        <Check aria-hidden />
                        {box ? `Mark all of box ${box.n} packed` : "Mark all packed"}
                      </Button>
                    )}
                  </span>
                </div>
                <ul className="grid gap-1.5">
                  {lines.map((line) => {
                    const n = Math.min(count(line), line.left);
                    const full = n >= line.left;
                    return (
                      <li
                        key={line.line_id}
                        className={cn(
                          "flex items-center gap-3 rounded-[10px] border px-3.5 py-3",
                          full ? "border-mint bg-mint-soft" : "border-border bg-card",
                        )}
                      >
                        <button
                          type="button"
                          aria-label={
                            full
                              ? `${line.title}: packed. Press to clear it`
                              : `Mark all ${line.left} × ${line.title} packed`
                          }
                          aria-pressed={full}
                          onClick={() => fill(line, full ? 0 : line.left)}
                          className={cn(
                            "grid size-[26px] shrink-0 place-items-center rounded-full border-2",
                            full
                              ? "border-mint-ink bg-mint-ink text-white"
                              : "border-input hover:bg-hover",
                          )}
                        >
                          {full && <Check className="size-4" aria-hidden />}
                        </button>
                        {line.image ? (
                          // eslint-disable-next-line @next/next/no-img-element -- the shop's own picture of the option, on the shop's image servers
                          <img
                            src={line.image}
                            alt=""
                            loading="lazy"
                            className="bg-sunken size-14 shrink-0 rounded-[7px] object-cover"
                          />
                        ) : (
                          <span className="bg-sunken size-14 shrink-0 rounded-[7px]" aria-hidden />
                        )}
                        <span className="grid min-w-0 flex-1 gap-[3px]">
                          <span className="text-[15.5px] leading-tight font-bold sm:text-[17px]">
                            {line.title}
                          </span>
                          {/* The option (colour, length, size) decides which one to grab, so it is the biggest thing on the line. */}
                          {line.variant && line.variant !== "Default Title" && (
                            <span
                              className={cn(
                                "w-fit rounded-lg border-[1.5px] px-2.5 py-0.5 text-lg leading-tight font-extrabold sm:text-[21px]",
                                full ? "border-mint-ink bg-white/55" : "border-ochre bg-ochre-soft",
                              )}
                            >
                              {line.variant}
                            </span>
                          )}
                          <span className="text-muted-foreground text-xs">
                            {[
                              line.from && `Order ${line.from}`,
                              line.sku && `SKU ${line.sku}`,
                              line.barcode && `Barcode ${line.barcode}`,
                            ]
                              .filter(Boolean)
                              .join(" · ") || "No code: tick it by hand"}
                          </span>
                        </span>
                        <button
                          type="button"
                          disabled={full}
                          title={full ? undefined : `Mark all ${line.left} packed`}
                          aria-label={`${n} of ${line.left} packed`}
                          onClick={() => fill(line, line.left)}
                          className="hover:enabled:border-input hover:enabled:bg-card min-w-14 rounded-[7px] border border-transparent px-1.5 py-0.5 text-right text-[22px] font-extrabold tabular-nums"
                        >
                          {n} / {line.left}
                        </button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={full}
                          title="Count one without scanning"
                          aria-label={`Count one ${line.title} without scanning`}
                          onClick={() => fill(line, n + 1)}
                        >
                          <Plus />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}

            {canBuy && (
              <BenchBuy
                key={`${order.id}:${payOk ? "ok" : ""}:${round}`}
                slug={slug}
                order={order}
                savedBoxes={savedBoxes}
                box={box && boxes.length > 1 ? { n: box.n, of: box.of } : null}
                verified={done}
                boxesChecked={box ? boxes.filter(boxDone).length : 0}
                part={!box && !order.together && !done ? scannedPart(lines, packed) : []}
                missing={notScanned(lines, packed)}
                unpaidOk={payOk}
                autoGo={autoGo}
                tellsShop={parcel.shopOffered && parcel.shopDefault}
                emailsCustomer={parcel.shopOffered && parcel.shopDefault && parcel.notifyDefault}
                refocus={focus}
                lines={order.lines.filter((line) => line.left > 0)}
                onBoxes={(now, splitChanged) => {
                  // What was scanned stays, held to what now goes in each box.
                  setPackedBy((before) =>
                    keepScanned(
                      before,
                      now.map((each, index) => ({ n: index + 1, items: each.items })),
                    ),
                  );
                  if (splitChanged) setResplit(true);
                  say(true, "Boxes saved. The price is being asked again.");
                  // The page reads the new boxes back: the box strip, and each box's slip code.
                  router.refresh();
                  focus();
                }}
                onBought={(bought, part) => {
                  beep(true);
                  if (box && boxes.length > 1 && bought.shipmentId && !part) {
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
                    setFinished({ bought, part });
                    setSaid(null);
                  }
                  focus();
                }}
              />
            )}
            {resplit && !shipment && (
              <p role="status" className={cn(notice, "bg-note flex flex-wrap items-center gap-3")}>
                <span>
                  The boxes changed, so slips printed before don&apos;t match any more. Print them
                  again: each box&apos;s slip and barcode follow the new split.
                </span>
                <SlipsButton
                  slug={slug}
                  href={`${base}/slips?order=${order.id}`}
                  selection={{ order: order.id }}
                >
                  Print the new slips
                </SlipsButton>
              </p>
            )}
            {shipment && boxes.length > 1 && (
              <p className="text-muted-foreground text-xs">
                The labels are bought, so the boxes are fixed now. To change them, void the parcel
                from the label builder and start again.
              </p>
            )}
            {order.hasLabel && !shipment && (
              <p className="text-muted-foreground text-xs">
                Reprint its label, or see its tracking, from the label builder.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {order && !finished && done && canWrite && !blocked && order.pickup && (
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
      {order && !finished && box && shipment && (done || boughtHere?.box === box.n) && (
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
              // Bought a moment ago for this very box, or its last item just scanned with
              // auto-print on: its label comes out by itself.
              auto={
                !printed.includes(box.n) &&
                ((boughtHere?.id === shipment.id && boughtHere.box === box.n) || autoBox === box.n)
              }
              primary
              onPrinted={() => {
                const now = [...new Set([...printed, box.n])];
                setPrintedHere((before) => [...new Set([...before, box.n])]);
                // Every box labelled: the next scan is the next order's slip.
                if (!nextBox(boxes, now)) setBoxesDone(true);
                focus();
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
      {order &&
        !finished &&
        done &&
        canWrite &&
        !blocked &&
        !order.pickup &&
        !order.together &&
        !shipment &&
        lines.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>
                {labels ? "Or record a parcel by hand" : "All packed. Record the parcel"}
              </CardTitle>
              <CardDescription>
                {labels
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
                quiet={labels}
                {...parcel}
              />
            </CardContent>
          </Card>
        )}
    </div>
  );
}

/** What the bench says once the label is bought: the order is done, or partly shipped. */
function DoneCard({
  slug,
  order,
  finished,
  onRest,
}: {
  slug: string;
  order: PackOrder;
  finished: Finished;
  onRest: () => void;
}) {
  const { bought, part } = finished;
  const base = `/w/${slug}/shipping`;
  return (
    <Card className="border-mint bg-mint-soft">
      <CardContent className="flex flex-col gap-3 pt-5">
        <h2 className="text-xl font-bold tabular-nums">
          {part ? `${order.name} partly shipped` : `${order.name} done`}
        </h2>
        <p className="text-sm tabular-nums">
          Parcel {bought.number} · {bought.service} · {formatPrice(bought.price, bought.currency)}
        </p>
        {part && part.left.length > 0 && (
          <p className="text-sm">
            {part.held
              ? `On hold until it can ship: ${part.left.join(", ")}.`
              : `Still to ship today: ${part.left.join(", ")}. It's back in To ship.`}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
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
            <Link
              href={order.builderHref}
              className="text-ochre-text text-sm font-medium hover:underline"
            >
              Open the order to print its label
            </Link>
          )}
          {part && !part.held && (
            <Button type="button" variant="outline" size="sm" onClick={onRest}>
              <Package aria-hidden /> Pack the rest now
            </Button>
          )}
          {part && bought.shipmentId && (
            <SlipsButton
              slug={slug}
              href={`${base}/slips?parcel=${bought.shipmentId}`}
              selection={{ parcel: bought.shipmentId }}
              title="A slip listing just what went in this box"
            >
              Packing slip for this box
            </SlipsButton>
          )}
        </div>
        <p className="text-xs">Scan the next packing slip.</p>
      </CardContent>
    </Card>
  );
}

/**
 * The box row and the buttons under the items. The plan is the one the To
 * ship list shows (box, weight, service), priced as soon as the order opens
 * and again whenever the box row changes; every purchase goes through the
 * same server path as the order page. An order that can't be planned says
 * why and points at its label builder.
 */
function BenchBuy({
  slug,
  order,
  savedBoxes,
  box,
  verified,
  boxesChecked,
  part,
  missing,
  unpaidOk,
  autoGo,
  tellsShop,
  emailsCustomer,
  refocus,
  lines,
  onBoxes,
  onBought,
}: {
  slug: string;
  order: PackOrder;
  savedBoxes: BenchSavedBox[];
  /** Packing one box of several: the purchase covers every box, and this box's label prints first. */
  box: { n: number; of: number } | null;
  /** Everything being packed (the order, or this box) is checked. */
  verified: boolean;
  /** How many of the boxes have been checked so far. */
  boxesChecked: number;
  /** What has been scanned so far, when that is only part of the order and can go on its own. */
  part: { line_id: string; qty: number }[];
  /** What hasn't been scanned yet, in words. */
  missing: string[];
  unpaidOk: boolean;
  /** Counts up each time the finishing scan should press the button by itself. */
  autoGo: number;
  /** The workspace's settings mark a bought label's order as sent in the shop. */
  tellsShop: boolean;
  emailsCustomer: boolean;
  refocus: () => void;
  /** Everything still to send, for laying the boxes out again. */
  lines: PackLine[];
  /** The boxes were changed and saved here; `splitChanged` when what is in each is different. */
  onBoxes: (boxes: BenchSplitBox[], splitChanged: boolean) => void;
  onBought: (bought: Bought, part: Finished["part"]) => void;
}) {
  const [plan, setPlan] = useState<ScanPlan | null>(null);
  /** "Change boxes" is open. */
  const [editing, setEditing] = useState(false);
  /** The box row as it reads now; null until the plan says what it starts as. */
  const [row, setRow] = useState<BenchBox | null>(null);
  /** A person changed the box row: it goes with every question from then on. */
  const [changed, setChanged] = useState(false);
  /** A person typed the weight. Until then it follows the items, whatever box is picked. */
  const [weighed, setWeighed] = useState(false);
  const [result, setResult] = useState<ScanBought | null>(null);
  const [buying, startBuy] = useTransition();
  /** "Ship what's scanned": the dialog, and the price for just those items. */
  const [parting, setParting] = useState<{ plan: ScanPlan | null; ask: Ask } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const pressed = useRef(false);
  const seq = useRef(0);
  /** What the price on screen was asked with: buying sends exactly the same. */
  const asked = useRef<Ask>({});
  /** The finishing scan landed before the price did: buy as soon as it arrives. */
  const wantGo = useRef(false);

  const withIds = order.together ? order.together.ids.filter((id) => id !== order.id) : [];
  const askNow = (boxRow: BenchBox | null): Ask => ({
    labelFormat: wantedLabelFormat(printSettings()),
    ...(withIds.length > 0 ? { withIds } : {}),
    ...(unpaidOk ? { unpaidOk: true } : {}),
    ...(boxRow ? { box: boxRow } : {}),
  });

  /** The row as it is sent: a weight nobody typed is left for the server to work out. */
  const sendable = (boxRow: BenchBox, typed: boolean): BenchBox =>
    typed ? boxRow : { ...boxRow, weightLb: "", weightOz: "" };

  const load = (boxRow: BenchBox | null, typed: boolean) => {
    const mine = ++seq.current;
    const sent = askNow(boxRow ? sendable(boxRow, typed) : null);
    void planScanLabel(slug, order.id, sent)
      .catch((): ScanPlan => ({ why: "We couldn't reach the carriers just now." }))
      .then((answer) => {
        if (mine !== seq.current) return;
        asked.current = sent;
        setPlan(answer);
        const planned = answer.box;
        if (!planned) return;
        // The row starts as the plan's box; after that it is the person's, except a
        // weight nobody typed, which goes on showing what the items come to.
        setRow((before) =>
          before === null
            ? planned
            : typed
              ? before
              : { ...before, weightLb: planned.weightLb, weightOz: planned.weightOz },
        );
      });
  };
  const ask = (boxRow: BenchBox | null, typed = weighed) => {
    setPlan(null);
    setResult(null);
    load(boxRow, typed);
  };
  const first = useEffectEvent(() => load(null, false));

  // Asked once as the order opens, like the list does. Asking buys nothing.
  useEffect(() => {
    first();
  }, []);

  // The box row changed: the new price, half a second after the last keystroke.
  const timer = useRef<number | undefined>(undefined);
  const change = (next: BenchBox, typed = weighed) => {
    setRow(next);
    setChanged(true);
    if (typed !== weighed) setWeighed(typed);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => ask(next, typed), 500);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const offer = plan?.offer;
  const purchase = (rateId: string, sent: Ask, part: Finished["part"]) => {
    // One press, one purchase.
    if (pressed.current) return;
    pressed.current = true;
    startBuy(async () => {
      const outcome = await buyScanLabel(slug, order.id, rateId, sent).catch((): ScanBought => ({
        unsure: true,
        error:
          "We lost touch part-way through, so we can't tell whether this label was bought. Please don't buy another. Open the label builder to check.",
      }));
      setResult(outcome);
      if (outcome.bought) onBought(outcome.bought, part);
      else {
        beep(false);
        // A plain "no" bought nothing, so the button comes back. Anything else stays locked.
        if (!outcome.unsure) pressed.current = false;
      }
      refocus();
    });
  };
  const go = (byItself: boolean) => {
    if (!offer || result?.unsure) return;
    if (!byItself && !verified) {
      const sure = box
        ? `Not every box has been packed and checked (${boxesChecked} of ${box.of}). Buy the labels for all ${box.of} boxes anyway?`
        : "Not every item has been scanned. Print the label for the whole order anyway?";
      if (!window.confirm(sure)) return;
    }
    purchase(offer.rateId, asked.current, null);
  };
  const goByItself = useEffectEvent(() => go(true));

  // Auto-print: the finishing scan presses the button, now or once the price is in.
  useEffect(() => {
    if (autoGo === 0) return;
    wantGo.current = true;
  }, [autoGo]);
  useEffect(() => {
    if (!wantGo.current || !plan) return;
    wantGo.current = false;
    // No price (a missing weight, an address to check): the page says why.
    if (plan.offer) goByItself();
  }, [plan, autoGo]);

  const openPart = () => {
    // The scanned items' own weight: a weight typed for the whole order doesn't carry over.
    const sent: Ask = {
      ...askNow(changed && row ? sendable(row, false) : null),
      part,
    };
    setParting({ plan: null, ask: sent });
    dialog.current?.showModal();
    void planScanLabel(slug, order.id, sent)
      .catch((): ScanPlan => ({ why: "We couldn't reach the carriers just now." }))
      .then((answer) => setParting((before) => (before ? { ...before, plan: answer } : before)));
  };
  const closePart = () => {
    dialog.current?.close();
    setParting(null);
    refocus();
  };
  const buyPart = (holdRest: boolean) => {
    const partOffer = parting?.plan?.offer;
    if (!partOffer || !parting) return;
    const sent = { ...parting.ask, holdRest };
    dialog.current?.close();
    setParting(null);
    purchase(partOffer.rateId, sent, { left: missing, held: holdRest });
  };

  const margin = offer ? benchMargin(order.paidAmount, offer.price) : null;
  const one = plan?.box !== null && row !== null;
  const field = (name: keyof BenchBox, label: string, step: string) => (
    <label className="flex min-w-[70px] flex-1 flex-col gap-1 text-xs font-semibold">
      {label}
      <Input
        type="number"
        min="0"
        step={step}
        inputMode="decimal"
        value={row?.[name] ?? ""}
        onChange={(event) => {
          if (!row) return;
          const next = { ...row, [name]: event.target.value };
          // A size typed in is no longer the saved box.
          if (name === "length" || name === "width" || name === "height") next.boxId = "";
          change(next, weighed || name === "weightLb" || name === "weightOz");
        }}
        onKeyDown={(event) => {
          // Enter here is done typing: the scanner gets the keyboard back.
          if (event.key === "Enter") {
            event.preventDefault();
            refocus();
          }
        }}
      />
    </label>
  );

  return (
    <>
      <div className="bg-sunken border-border flex flex-wrap items-end gap-2.5 rounded-[10px] border p-3">
        {one && row ? (
          <>
            <label className="flex min-w-[200px] flex-[2] flex-col gap-1 text-xs font-semibold">
              Box
              <Select
                aria-label="Box"
                value={row.boxId}
                onChange={(event) => {
                  const picked = savedBoxes.find((each) => each.id === event.target.value);
                  change(
                    picked
                      ? {
                          ...row,
                          boxId: picked.id,
                          length: picked.length,
                          width: picked.width,
                          height: picked.height,
                        }
                      : { ...row, boxId: "" },
                  );
                  refocus();
                }}
              >
                <option value="">Custom size</option>
                {savedBoxes.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </Select>
            </label>
            {field("length", "L in", "0.5")}
            {field("width", "W in", "0.5")}
            {field("height", "H in", "0.5")}
            {field("weightLb", "Weight lb", "1")}
            {field("weightOz", "oz", "0.1")}
          </>
        ) : (
          <span className="text-sm">
            {plan?.boxNames && plan.boxNames.length > 1
              ? `${plan.boxNames.length} boxes: ${plan.boxNames.join(" + ")}`
              : plan
                ? ""
                : "Working out its box…"}
          </span>
        )}
        <div className="ml-auto grid min-w-[200px] justify-items-end gap-1 text-right text-xs">
          <span aria-live="polite">
            {!plan ? (
              <span className="text-muted-foreground">Asking the carriers for a price…</span>
            ) : offer ? (
              <>
                {offer.service} ·{" "}
                <b className="tabular-nums">{formatPrice(offer.price, offer.currency)}</b>
                {margin !== null && (
                  <>
                    {" · "}
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        margin >= 0 ? "text-mint-ink" : "text-brick",
                      )}
                    >
                      {margin >= 0 ? "+" : "−"}
                      {formatPrice((Math.abs(margin) / 100).toFixed(2), offer.currency)} margin
                    </span>
                  </>
                )}
                <span className="text-muted-foreground block">
                  {offer.packing}
                  {offer.days ? ` · about ${offer.days} ${offer.days === 1 ? "day" : "days"}` : ""}
                  {tellsShop
                    ? emailsCustomer
                      ? " · your shop is told, and emails the tracking"
                      : " · your shop is told it's sent"
                    : ""}
                </span>
              </>
            ) : plan.needsWeight ? (
              <span className="text-muted-foreground">
                Enter the box size and weight for a rate
              </span>
            ) : (
              <span className="text-brick">{plan.why}</span>
            )}
          </span>
          <span className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
            {!order.together && (plan?.boxes?.length ?? 0) > 0 && (
              <button
                type="button"
                className="text-ochre-text font-medium underline-offset-2 hover:underline"
                title="Add or remove a box, and say what goes in each. Until the label is bought."
                onClick={() => setEditing(true)}
              >
                {one ? "Split into boxes" : "Change boxes"}
              </button>
            )}
            <Link
              href={order.builderHref}
              className="text-ochre-text font-medium underline-offset-2 hover:underline"
            >
              More options
            </Link>
          </span>
        </div>
      </div>

      {result?.error && (
        <p
          role="alert"
          className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm"
        >
          {result.error}{" "}
          {result.unsure ? (
            <Link href={order.builderHref} className="font-semibold underline">
              Open the label builder
            </Link>
          ) : (
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => ask(changed ? row : null)}
            >
              Get the price again
            </button>
          )}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {plan?.signature ? "Signature required" : ""}
        </span>
        {!result?.unsure && (
          <span className="flex flex-wrap items-center justify-end gap-2">
            {part.length > 0 && !box && (
              <Button
                type="button"
                variant="outline"
                size="lg"
                disabled={buying}
                title="Ship the scanned items now: the rest goes in another box today, or waits on hold if it's out of stock"
                onClick={openPart}
              >
                Ship what&apos;s scanned
              </Button>
            )}
            {plan && !offer && plan.needsWeight ? (
              <span className="text-muted-foreground text-xs">Enter the weight to print</span>
            ) : (
              <Button
                type="button"
                size="lg"
                variant={verified ? "default" : "outline"}
                disabled={buying || !offer}
                onClick={() => go(false)}
              >
                <Printer aria-hidden />
                {buying
                  ? "Buying…"
                  : box
                    ? verified
                      ? `Buy ${box.of} labels & print box ${box.n}`
                      : `Buy ${box.of} labels now & print box ${box.n}`
                    : verified
                      ? "Verify & print label"
                      : "Print label anyway"}
              </Button>
            )}
          </span>
        )}
      </div>

      {editing && plan?.boxes && (
        <BoxEditor
          slug={slug}
          orderId={order.id}
          orderName={order.name}
          start={plan.boxes}
          lines={lines}
          savedBoxes={savedBoxes}
          onClose={() => {
            setEditing(false);
            refocus();
          }}
          onSaved={(now) => {
            const before = plan.boxes ?? [];
            setEditing(false);
            // The saved boxes are the order's own from here: the row starts again from them.
            setRow(null);
            setChanged(false);
            setWeighed(false);
            setPlan(null);
            setResult(null);
            load(null, false);
            onBoxes(now, !sameSplit(before, now));
          }}
        />
      )}

      <dialog
        ref={dialog}
        aria-labelledby="ship-scanned-title"
        className="fixed inset-0 m-0 grid h-full max-h-none w-full max-w-none place-items-center bg-transparent p-4 backdrop:bg-black/50 [&:not([open])]:hidden"
        onCancel={(event) => {
          event.preventDefault();
          closePart();
        }}
      >
        {parting && (
          <div className="bg-card text-foreground border-border flex w-full max-w-[480px] flex-col gap-3 rounded-lg border p-5 text-left text-sm shadow-lg">
            <p id="ship-scanned-title" className="text-base font-bold">
              Ship what&apos;s scanned
            </p>
            <p>This label covers only what&apos;s been scanned. Not in this box:</p>
            <ul className="list-disc pl-5">
              {missing.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p aria-live="polite">
              {!parting.plan ? (
                <span className="text-muted-foreground">Asking the carriers for a price…</span>
              ) : parting.plan.offer ? (
                <>
                  {parting.plan.offer.service} ·{" "}
                  <b className="tabular-nums">
                    {formatPrice(parting.plan.offer.price, parting.plan.offer.currency)}
                  </b>
                  <span className="text-muted-foreground block text-xs">
                    {parting.plan.offer.packing}
                  </span>
                </>
              ) : (
                <span className="text-brick">
                  {parting.plan.needsWeight
                    ? "There's no weight on file for just these items."
                    : parting.plan.why}{" "}
                  <Link
                    href={`${order.builderHref}?part=${partQuery(part)}`}
                    className="font-semibold underline"
                  >
                    Finish it on the label builder
                  </Link>
                  , with the scanned amounts filled in.
                </span>
              )}
            </p>
            <p className="text-muted-foreground text-xs">
              Your shop marks only the shipped items as sent. “Today” puts the rest straight back in
              To ship to pack in another box; “Hold” keeps it waiting until it&apos;s in stock.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                disabled={!parting.plan?.offer}
                onClick={() => buyPart(false)}
              >
                <Package aria-hidden /> Ship the rest today in another box
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!parting.plan?.offer}
                onClick={() => buyPart(true)}
              >
                Hold the rest: out of stock
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={closePart}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </dialog>
    </>
  );
}

type Ask = NonNullable<Parameters<typeof planScanLabel>[2]>;

/**
 * "Change boxes": the label builder's box list, at the bench. Add a box,
 * remove one (its items go to the box before it), pick each box's size, and
 * say how many of each item is in each. Saved as the order's own choice once
 * every item has a box; nothing is priced or bought from here.
 */
function BoxEditor({
  slug,
  orderId,
  orderName,
  start,
  lines,
  savedBoxes,
  onClose,
  onSaved,
}: {
  slug: string;
  orderId: string;
  orderName: string;
  start: BenchSplitBox[];
  lines: PackLine[];
  savedBoxes: BenchSavedBox[];
  onClose: () => void;
  onSaved: (boxes: BenchSplitBox[]) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [boxes, setBoxes] = useState<BenchSplitBox[]>(start);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, []);
  const change = (next: BenchSplitBox[]) => {
    setBoxes(next);
    setError(null);
  };
  const edit = (index: number, patch: Partial<BenchSplitBox>) =>
    change(boxes.map((box, i) => (i === index ? { ...box, ...patch } : box)));
  const split = boxes.length > 1;
  const loose = lines.reduce((sum, line) => sum + Math.max(0, notBoxed(boxes, line)), 0);
  const save = () => {
    const checked = benchSplitChoice(boxes, lines);
    if ("error" in checked) return setError(checked.error);
    startSave(async () => {
      const result = await saveBenchBoxes(slug, orderId, boxes).catch(() => ({
        error: "That didn't save. Please try again.",
      }));
      if ("error" in result && result.error) return setError(result.error);
      onSaved(boxes);
    });
  };
  const small = "h-[30px] w-[4.5rem] px-2 text-xs";

  return (
    <dialog
      ref={ref}
      aria-labelledby="change-boxes-title"
      className="fixed inset-0 m-0 grid h-full max-h-none w-full max-w-none place-items-center overflow-y-auto bg-transparent p-4 backdrop:bg-black/50"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="bg-card text-foreground border-border flex w-full max-w-[720px] flex-col gap-4 rounded-lg border p-5 text-left text-sm shadow-lg">
        <div>
          <p id="change-boxes-title" className="text-base font-bold">
            Boxes for {orderName}
          </p>
          <p className="text-muted-foreground text-xs">
            Change the boxes and what goes in each, until the label is bought. What you&apos;ve
            scanned so far is kept. Leave a weight empty and it follows the items.
          </p>
        </div>
        <ul className="grid gap-2">
          {boxes.map((box, index) => (
            <li
              key={index}
              className="bg-sunken border-border flex flex-wrap items-end gap-2 rounded-[10px] border p-2.5"
            >
              <span className="w-12 pb-1.5 text-xs font-bold">Box {index + 1}</span>
              <label className="flex min-w-[150px] flex-1 flex-col gap-1 text-xs font-semibold">
                Size
                <Select
                  aria-label={`Box ${index + 1}`}
                  className="h-[30px] text-xs"
                  value={box.boxId}
                  onChange={(event) => {
                    const picked = savedBoxes.find((each) => each.id === event.target.value);
                    edit(
                      index,
                      picked
                        ? {
                            boxId: picked.id,
                            length: picked.length,
                            width: picked.width,
                            height: picked.height,
                          }
                        : { boxId: "" },
                    );
                  }}
                >
                  <option value="">Custom size</option>
                  {savedBoxes.map((each) => (
                    <option key={each.id} value={each.id}>
                      {each.name}
                    </option>
                  ))}
                </Select>
              </label>
              {(
                [
                  ["length", "L in"],
                  ["width", "W in"],
                  ["height", "H in"],
                  ["weightLb", "lb"],
                  ["weightOz", "oz"],
                ] as const
              ).map(([name, label]) => (
                <label key={name} className="flex flex-col gap-1 text-xs font-semibold">
                  {label}
                  <Input
                    type="number"
                    min="0"
                    step={name === "weightOz" ? "0.1" : name === "weightLb" ? "1" : "0.5"}
                    inputMode="decimal"
                    aria-label={`Box ${index + 1} ${label}`}
                    className={small}
                    value={box[name]}
                    onChange={(event) =>
                      edit(index, {
                        [name]: event.target.value,
                        // A size typed in is no longer the saved box.
                        ...(name.startsWith("weight") ? {} : { boxId: "" }),
                      })
                    }
                  />
                </label>
              ))}
              {split && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove box ${index + 1}`}
                  title="Remove this box (its items go to the box before it)"
                  onClick={() => change(removeSplitBox(boxes, index))}
                >
                  <X />
                </Button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={boxes.length >= BENCH_MAX_BOXES}
            title="Too much for one box? Each box gets its own label and tracking number."
            onClick={() => change(addSplitBox(boxes))}
          >
            <Plus aria-hidden /> Add another box
          </Button>
          {split && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Spread the items so each box weighs about the same"
              onClick={() => change(splitEvenly(boxes, lines))}
            >
              Split evenly
            </Button>
          )}
        </div>
        {split && (
          <ul className="divide-border border-border divide-y rounded-[10px] border">
            {lines.map((line) => {
              const out = notBoxed(boxes, line);
              return (
                <li key={line.line_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                  <span className="min-w-[160px] flex-1">
                    <span className="font-semibold">
                      {line.left} × {line.title}
                    </span>
                    {line.variant && line.variant !== "Default Title" && (
                      <span className="text-muted-foreground"> · {line.variant}</span>
                    )}
                    {out !== 0 && (
                      <span className="text-brick block text-xs font-semibold">
                        {out > 0 ? `${out} not in a box` : `${-out} too many boxed`}
                      </span>
                    )}
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {boxes.map((box, index) =>
                      line.left === 1 ? (
                        <button
                          key={index}
                          type="button"
                          role="radio"
                          aria-checked={(box.items[line.line_id] ?? 0) > 0}
                          aria-label={`${line.title} in box ${index + 1}`}
                          onClick={() => change(setSplitQty(boxes, line, index, 1))}
                          className={cn(
                            "border-input h-[30px] rounded-sm border px-2.5 text-xs font-semibold",
                            (box.items[line.line_id] ?? 0) > 0
                              ? "bg-teal text-on-teal"
                              : "bg-card hover:bg-hover",
                          )}
                        >
                          Box {index + 1}
                        </button>
                      ) : (
                        <label key={index} className="flex items-center gap-1 text-xs">
                          <span className="text-muted-foreground">Box {index + 1}</span>
                          <Input
                            type="number"
                            min="0"
                            max={line.left}
                            inputMode="numeric"
                            aria-label={`${line.title} in box ${index + 1}`}
                            className="h-[30px] w-14 px-2 text-xs"
                            value={box.items[line.line_id] ?? 0}
                            onChange={(event) =>
                              change(setSplitQty(boxes, line, index, Number(event.target.value)))
                            }
                          />
                        </label>
                      ),
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p
            role="alert"
            className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm"
          >
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={saving || loose > 0} onClick={save}>
            {saving ? "Saving…" : "Save boxes"}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {split && (
            <span className="text-muted-foreground text-xs">
              Each box gets its own slip, label and tracking number.
            </span>
          )}
        </div>
      </div>
    </dialog>
  );
}
