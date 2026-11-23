"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, Minus, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { allPacked, orderCode, scanItem, type PackLine } from "@/lib/shipping/scan";
import { cn } from "@/lib/utils";
import { ParcelForm, PickupForm } from "../forms";

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
}) {
  const router = useRouter();
  const base = `/w/${slug}/shipping`;
  const box = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [packed, setPacked] = useState<Record<string, number>>({});
  const [said, setSaid] = useState<Said>(null);

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
    if (!order) {
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
              {order ? `Scan the items for ${order.name}` : "Scanner"}
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
                order
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
                  />
                </CardContent>
              )}
            </Card>
          )}
          {done && canWrite && !order.held && !order.pickup && (
            <Card>
              <CardHeader>
                <CardTitle>All packed. Record the parcel</CardTitle>
                <CardDescription>
                  Buy the postage wherever you usually do, then scan or paste the tracking number.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ParcelForm
                  slug={slug}
                  orderId={order.id}
                  lines={lines}
                  backTo="scan"
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
