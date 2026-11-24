"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import type { PlanCell } from "@/lib/shipping/list";
import { holdOrders, markPickupReady, releaseOrders, type ShippingState } from "./actions";
import { CarrierMark } from "./carrier-mark";
import { HoldPicker, type HoldChoice } from "./hold-picker";
import { planNextOrders } from "./plan-actions";
import { useShipTogether } from "./together-ui";

export type QueueRow = {
  id: string;
  name: string;
  /** "4h ago", "1d ago". */
  age: string;
  /** The day and time it came in, for hovering over the age. */
  placed: string;
  customer: string;
  email: string | null;
  /** How many things are still to go (or were ordered, once it's finished). */
  itemCount: number;
  /** "2 × Wool rug (Large), 3 × Yarn bundle" */
  items: string;
  /** The items' own weight, for when there's no box to add. */
  weight: string;
  chose: string;
  priority: boolean;
  paid: string;
  place: string;
  needsAddress: boolean;
  /** Still something to do on it. Search can also turn up orders that are finished. */
  open: boolean;
  /** For finished orders: "Shipped", "Cancelled"... */
  status: string | null;
  hold: "none" | "held" | "back";
  holdUntil: string;
  holdNote: string;
  unpaid: boolean;
  pickup: boolean;
  pickupReady: boolean;
  partSent: boolean;
  slipPrinted: boolean;
  /** The workspace's rule asks for a signature on this one. */
  signature: boolean;
  /** The box, best price and address check the list has for it. */
  plan: PlanCell;
};

const th = "py-2 pr-4 text-left font-semibold whitespace-nowrap";
const td = "py-2.5 pr-4 align-top";

const isWaiting = (plan: PlanCell) => plan.quote.state === "waiting" || plan.address === "waiting";
const Dash = ({ title }: { title?: string }) => (
  <span className="text-muted-foreground" title={title || undefined}>
    –
  </span>
);
const Working = ({ wide = false }: { wide?: boolean }) => (
  <span
    aria-hidden
    className={`bg-sunken inline-block h-3 animate-pulse rounded ${wide ? "w-28" : "w-16"}`}
  />
);

/** How many rounds one visit asks for: plenty for a full screen of orders, and an end if something sticks. */
const MOST_ROUNDS = 40;

/** The to-ship table: tick orders to print their slips, hold or release them, or call pickups ready. */
export function QueueTable({
  slug,
  rows,
  canWrite,
  today,
  choices,
  view,
  fill,
}: {
  slug: string;
  rows: QueueRow[];
  canWrite: boolean;
  today: string;
  choices: HoldChoice[];
  /** The chip these rows came from, so stepping order to order stays inside it. */
  view?: string;
  /**
   * The chip whose missing boxes, prices and address checks are worked out
   * in the background once the list is on screen. Left out: nothing is asked.
   */
  fill?: string;
}) {
  const base = `/w/${slug}/shipping`;
  const router = useRouter();
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [holding, setHolding] = useState(false);
  const [note, setNote] = useState("");
  const [until, setUntil] = useState<string | null>(null);
  const [result, setResult] = useState<ShippingState>({});
  const [pending, start] = useTransition();

  // What the server couldn't say yet is asked for a few orders at a time, and
  // laid over the rows as it arrives. The server's own answer wins once it has one.
  const [filled, setFilled] = useState<Record<string, PlanCell>>({});
  const waitingIds = fill
    ? rows
        .filter((row) => isWaiting(row.plan))
        .map((row) => row.id)
        .join(",")
    : "";
  const [finished, setFinished] = useState<string | null>(null);
  const working = waitingIds !== "" && finished !== waitingIds;
  useEffect(() => {
    if (!fill || !waitingIds) return;
    let stopped = false;
    void (async () => {
      try {
        for (let round = 0; round < MOST_ROUNDS && !stopped; round++) {
          const result = await planNextOrders(slug, fill);
          if (stopped) return;
          const got = Object.keys(result.cells).length;
          if (got > 0) setFilled((before) => ({ ...before, ...result.cells }));
          if (got === 0 || result.left <= 0) break;
        }
      } catch {
        // The list is whole without these: whatever is missing shows as a dash.
      }
      if (!stopped) setFinished(waitingIds);
    })();
    return () => {
      stopped = true;
    };
  }, [fill, waitingIds, slug]);
  const planOf = (row: QueueRow): PlanCell =>
    isWaiting(row.plan) ? (filled[row.id] ?? row.plan) : row.plan;

  const tickable = rows.filter((row) => row.open);
  const picked = tickable.filter((row) => ticked.has(row.id));
  const ids = picked.map((row) => row.id);
  const pickups = picked.filter((row) => row.pickup && !row.pickupReady);
  const toHold = picked.some((row) => row.hold !== "held");
  const toRelease = picked.some((row) => row.hold !== "none");
  const allTicked = tickable.length > 0 && picked.length === tickable.length;
  // One parcel for several orders: only ones that are posted, and not set aside.
  const together = useShipTogether(slug);
  const canGoTogether =
    picked.length >= 2 &&
    picked.length <= 10 &&
    picked.every((row) => !row.pickup && row.hold !== "held");

  const toggle = (id: string) =>
    setTicked((before) => {
      const next = new Set(before);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const run = (work: () => Promise<ShippingState>) =>
    start(async () => {
      const outcome = await work();
      setResult(outcome);
      if (!outcome.error) {
        setTicked(new Set());
        setHolding(false);
        setNote("");
        setUntil(null);
      }
    });

  return (
    <div className="flex flex-col gap-3">
      {picked.length > 0 && (
        <div
          role="region"
          aria-label="Selected orders"
          className="bg-card border-border sticky top-2 z-10 flex flex-col gap-3 rounded-lg border px-4 py-3 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-sm font-bold tabular-nums">{picked.length} selected</span>
            {pickups.length > 0 && canWrite && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  run(() =>
                    markPickupReady(
                      slug,
                      pickups.map((row) => row.id),
                    ),
                  )
                }
              >
                Mark {pickups.length} ready for pickup
              </Button>
            )}
            {toHold && canWrite && (
              <Button
                variant="outline"
                size="sm"
                aria-expanded={holding}
                disabled={pending}
                onClick={() => setHolding((open) => !open)}
              >
                Hold
              </Button>
            )}
            {toRelease && canWrite && (
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => run(() => releaseOrders(slug, ids))}
              >
                Release
              </Button>
            )}
            {canGoTogether && canWrite && (
              <Button
                variant="outline"
                size="sm"
                disabled={together.pending}
                title="One parcel and one label for these orders (same name and address)"
                onClick={() => together.open(ids)}
              >
                {together.pending ? "Opening…" : "Ship together"}
              </Button>
            )}
            <Button asChild size="sm">
              <Link href={`${base}/slips?ids=${ids.slice(0, 150).join(",")}`}>Packing slips</Link>
            </Button>
          </div>
          {holding && toHold && (
            <div className="border-border flex flex-col gap-3 border-t pt-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="bulk-hold-note">Why they&apos;re waiting</Label>
                <Input
                  id="bulk-hold-note"
                  value={note}
                  maxLength={300}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="Waiting on yarn, checking the address…"
                />
              </div>
              <HoldPicker
                id="bulk-hold-until"
                today={today}
                choices={choices}
                value={until}
                onChange={setUntil}
              />
              <div className="flex gap-2">
                <Button
                  variant="dark"
                  size="sm"
                  disabled={pending}
                  onClick={() => run(() => holdOrders(slug, ids, note, until))}
                >
                  {pending
                    ? "Saving…"
                    : `Hold ${picked.length === 1 ? picked[0].name : `${picked.length} orders`}`}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setHolding(false)}>
                  Never mind
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
      <FormMessage>{result.error ?? together.error}</FormMessage>
      <FormMessage kind="success">{result.message}</FormMessage>
      {together.dialog}

      {working && (
        <p role="status" className="text-muted-foreground text-xs">
          Working out boxes and quotes…
        </p>
      )}
      {/* `relative` keeps the screen-reader-only heading inside the scrolling box, so the page itself never scrolls sideways. */}
      <div className="bg-card border-border relative overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[1240px] text-sm">
          <thead className="text-muted-foreground border-border border-b text-xs">
            <tr>
              <th className="w-10 py-2 pl-4">
                <input
                  type="checkbox"
                  aria-label="Select every order shown"
                  checked={allTicked}
                  disabled={tickable.length === 0}
                  onChange={() =>
                    setTicked(allTicked ? new Set() : new Set(tickable.map((row) => row.id)))
                  }
                />
              </th>
              <th className={th}>Order</th>
              <th className={th}>Customer</th>
              <th className={th}>Items</th>
              <th className={th}>Weight</th>
              <th className={th}>Box</th>
              <th className={th}>Customer chose</th>
              <th className={`${th} text-right`}>Paid</th>
              <th className={th}>Best quote · margin</th>
              <th className={th}>Ship to</th>
              <th className={th}>
                <span className="sr-only">Flags</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-border divide-y">
            {rows.map((row) => {
              const plan = planOf(row);
              const quote = plan.quote;
              return (
                <tr
                  key={row.id}
                  // Anywhere on the line opens the order; ticks, buttons and links keep their own job.
                  onClick={(event) => {
                    const target = event.target as HTMLElement;
                    if (target.closest("a, button, input, label, select, textarea")) return;
                    if (window.getSelection()?.toString()) return;
                    router.push(`${base}/orders/${row.id}${view ? `?view=${view}` : ""}`);
                  }}
                  className={`cursor-pointer ${ticked.has(row.id) ? "bg-hover" : "hover:bg-hover/60"}`}
                >
                  <td className="py-2.5 pl-4 align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select order ${row.name}`}
                      checked={ticked.has(row.id)}
                      disabled={!row.open}
                      onChange={() => toggle(row.id)}
                    />
                  </td>
                  <td className={`${td} whitespace-nowrap`}>
                    <Link
                      href={`${base}/orders/${row.id}${view ? `?view=${view}` : ""}`}
                      className="font-bold tabular-nums hover:underline"
                    >
                      {row.name}
                    </Link>
                    <span className="text-muted-foreground block text-xs" title={row.placed}>
                      {row.age}
                    </span>
                  </td>
                  <td className={`${td} max-w-[16rem]`}>
                    <span className="font-read" title={row.email ?? undefined}>
                      {row.customer}
                    </span>
                  </td>
                  <td className={`${td} tabular-nums`} title={row.items || undefined}>
                    {row.itemCount}
                  </td>
                  <td className={`${td} whitespace-nowrap tabular-nums`}>
                    {plan.weight || row.weight || (
                      <Dash title="The shop hasn't given a weight for these items." />
                    )}
                  </td>
                  <td className={`${td} max-w-[12rem]`}>
                    {plan.box ? (
                      <>
                        <span className="block truncate" title={plan.box}>
                          {plan.box}
                        </span>
                        {plan.boxNote && (
                          <span className="text-muted-foreground block text-xs">
                            {plan.boxNote}
                          </span>
                        )}
                      </>
                    ) : (
                      <Dash />
                    )}
                  </td>
                  <td className={`${td} max-w-[14rem]`}>
                    <span className="font-read">{row.chose}</span>
                    {row.priority && (
                      <Badge tone="waiting" className="ml-1.5">
                        Priority
                      </Badge>
                    )}
                  </td>
                  <td className={`${td} text-right whitespace-nowrap tabular-nums`}>{row.paid}</td>
                  <td className={`${td} min-w-[15rem]`}>
                    {quote.state === "ok" ? (
                      <>
                        <span className="flex items-center gap-2">
                          <CarrierMark mark={quote.mark} />
                          <span className="min-w-0 flex-1 truncate text-xs">
                            {quote.service}
                            <span className="text-muted-foreground"> · {quote.source}</span>
                          </span>
                          <b className="whitespace-nowrap tabular-nums">{quote.price}</b>
                        </span>
                        {quote.margin && (
                          <span
                            className={`block text-xs font-semibold tabular-nums ${quote.margin.short ? "text-brick" : "text-mint-ink"}`}
                          >
                            {quote.margin.text}
                          </span>
                        )}
                      </>
                    ) : quote.state === "waiting" ? (
                      working ? (
                        <Working wide />
                      ) : (
                        <Dash title="Not worked out yet. Refresh, or open the order to see prices." />
                      )
                    ) : quote.state === "none" ? (
                      <span
                        className="text-muted-foreground text-xs"
                        title="No carrier offered a price for this box and weight just now. Open the order to try again."
                      >
                        No quote
                      </span>
                    ) : (
                      <Dash title={quote.why} />
                    )}
                  </td>
                  <td className={`${td} max-w-[14rem]`}>
                    <span className="font-read">{row.place}</span>
                    {plan.address === "found" && (
                      <span className="text-mint-ink flex items-center gap-1 text-xs font-semibold">
                        <Check aria-hidden className="size-3" />
                        Address found
                      </span>
                    )}
                    {plan.address === "not_found" && (
                      <span className="text-brick flex items-center gap-1 text-xs font-semibold">
                        <TriangleAlert aria-hidden className="size-3" />
                        Address not found
                      </span>
                    )}
                    {plan.address === "waiting" && working && (
                      <span className="block">
                        <Working />
                      </span>
                    )}
                  </td>
                  <td className="py-2.5 pr-4 align-top">
                    <span className="flex flex-wrap justify-end gap-1.5">
                      {row.status && <Badge>{row.status}</Badge>}
                      {row.hold === "held" && (
                        <Badge tone="bad">
                          {row.holdUntil ? `Hold · until ${row.holdUntil}` : "On hold"}
                        </Badge>
                      )}
                      {row.hold === "back" && <Badge tone="good">Back from hold</Badge>}
                      {row.unpaid && row.open && <Badge tone="waiting">Payment pending</Badge>}
                      {row.pickup &&
                        row.open &&
                        (row.pickupReady ? (
                          <Badge tone="good">Ready for pickup</Badge>
                        ) : (
                          <Badge tone="open">Pickup</Badge>
                        ))}
                      {row.needsAddress && <Badge tone="bad">Needs an address</Badge>}
                      {row.partSent && <Badge tone="waiting">Part sent</Badge>}
                      {row.slipPrinted && row.open && <Badge>Slip printed</Badge>}
                      {row.signature && <Badge>Signature</Badge>}
                    </span>
                    {row.hold === "held" && row.holdNote && (
                      <span className="text-muted-foreground font-read mt-1 block text-right text-xs">
                        {row.holdNote}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
