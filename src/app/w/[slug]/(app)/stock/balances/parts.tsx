import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { localDay } from "@/lib/bookings/slots";
import { activityType, sourceLabel, type ActivityType } from "@/lib/stock/balance/activity";
import type { AgingBucket, AgingResult, OpenBill } from "@/lib/stock/balance/aging";
import { describeBalance } from "@/lib/stock/balance/format";
import type { HistoryRow } from "@/lib/stock/balance/history";
import { Money } from "@/lib/stock/balance/money";
import type { ConfirmedMark, WaitingMark } from "@/lib/stock/balance/paid-marks";
import type { CombinedSummary, DueGroup } from "@/lib/stock/balance/summary";
import {
  cardLineWords,
  confirmedWords,
  dueWords,
  payByHint,
  weekDay,
  type CardFacts,
} from "@/lib/stock/balance/words";
import { cn } from "@/lib/utils";
import { setBalanceNotice } from "./actions";
import type { LedgerRow } from "./data";
import { PaidTick, RemoveEntryButton } from "./forms";

export type MoneyText = (value: string | number) => string;

/**
 * Money in the workspace's currency, always with cents and never with a minus
 * sign: which way an amount points is said in words ("credit") beside it.
 */
export function moneyText(currency: string): MoneyText {
  const format = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (value) => format.format(Math.abs(new Money(value).cents) / 100);
}

const DAY_STYLES = {
  short: { month: "short", day: "numeric" },
  full: { month: "short", day: "numeric", year: "numeric" },
  weekday: { weekday: "short", month: "short", day: "numeric" },
} as const;

/** "2026-11-17" as "Nov 17". A plain date, so it is never shifted by a time zone. */
export function day(value: string, style: keyof typeof DAY_STYLES = "short"): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...DAY_STYLES[style] }).format(
    new Date(`${value.slice(0, 10)}T12:00:00Z`),
  );
}

/** A moment as the workspace's clock has it: "Nov 24, 2026, 11:26 AM ET". */
export function moment(instant: string, timeZone: string): string {
  const text = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(instant));
  return timeZone === "America/New_York" ? `${text} ET` : text;
}

export const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export const th = "py-2 pr-3 font-semibold";
export const td = "py-2 pr-3 align-top";

/** The small capital label over a panel or on a card, as on the owner's old page. */
export const label = "text-muted-foreground text-xs font-semibold tracking-wide uppercase";

/** A panel: a label on the left, a line of figures on the right, then its content. */
export function Panel({
  title,
  aside,
  children,
  className,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className={label}>{title}</h2>
          {aside && <div className="text-sm">{aside}</div>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** An invoice's number, in mono type, opening that invoice's own page. */
export function InvoiceLink({
  base,
  id,
  reference,
}: {
  base: string;
  id: string;
  reference: string | null;
}) {
  return (
    <Link
      href={`${base}/invoice/${id}`}
      className="hover:decoration-foreground font-mono text-[13px] underline decoration-[var(--tuft-border-strong)] underline-offset-2"
    >
      {reference ?? "no number"}
    </Link>
  );
}

/**
 * The row of cards over both pages: the total across every supplier (dark),
 * then one card per supplier. Each opens that supplier; the total goes back
 * to everyone. `selectedId` is the supplier being looked at, or "all".
 */
export function SupplierCards({
  base,
  combined,
  cards,
  selectedId,
  money,
}: {
  base: string;
  combined: CombinedSummary;
  cards: CardFacts[];
  selectedId: string;
  money: MoneyText;
}) {
  const pastDue = new Money(combined.overdue).gt(0);
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <li>
        <Link
          href={base}
          scroll={false}
          aria-current={selectedId === "all" ? "page" : undefined}
          className={cn(
            "bg-teal text-on-teal hover:bg-teal-2 flex h-full flex-col gap-1 rounded-xl p-5 transition-colors duration-150",
            selectedId === "all" && "ring-teal ring-offset-background ring-2 ring-offset-2",
          )}
        >
          <span className="text-xs font-semibold tracking-wide uppercase opacity-80">
            Total due · all suppliers
          </span>
          <span className="text-3xl leading-tight font-bold tabular-nums">
            {money(combined.owed)}
          </span>
          <span className="text-xs">
            {pastDue ? (
              <>
                <span className="text-ochre font-semibold">{money(combined.overdue)} past due</span>{" "}
                <span className="opacity-80">
                  ({combined.overdueBills} bill{combined.overdueBills === 1 ? "" : "s"})
                </span>
              </>
            ) : (
              <span className="opacity-80">Nothing past due</span>
            )}
          </span>
          {new Money(combined.markedPaid).gt(0) && (
            <span className="text-xs text-[var(--tuft-mint)]">
              {money(combined.markedPaid)} of it already paid — waiting for the payment to post
            </span>
          )}
          {new Money(combined.credit).gt(0) && (
            <span className="text-xs text-[var(--tuft-mint)]">
              Plus {money(combined.credit)} credit in your favour. A credit with one supplier
              isn&apos;t taken off what you owe another.
            </span>
          )}
        </Link>
      </li>
      {cards.map((card) => {
        const selected = card.supplierId === selectedId;
        return (
          <li key={card.supplierId}>
            <Link
              href={`${base}/${card.supplierId}`}
              scroll={false}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "bg-card hover:bg-hover flex h-full flex-col gap-1 rounded-xl border p-5 transition-colors duration-150",
                selected ? "border-teal ring-teal ring-1" : "border-border",
              )}
            >
              <span className={cn(label, "truncate")}>{card.name}</span>
              <span className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    "text-2xl leading-tight font-bold tabular-nums",
                    card.direction === "credit" && "text-mint-ink",
                  )}
                >
                  {money(card.balance)}
                </span>
                {card.direction === "credit" && <Badge tone="good">Credit</Badge>}
              </span>
              <span
                className={cn(
                  "text-xs",
                  card.line.kind === "pastDue"
                    ? "text-brick font-semibold"
                    : "text-muted-foreground",
                )}
              >
                {cardLineWords(card.line, money)}
              </span>
              {card.waiting && (
                <span className="text-mint-ink text-xs">
                  {money(card.waiting)} paid, waiting to post
                </span>
              )}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** A balance that may be a credit: the amount, and the word when it is one. */
export function BalanceValue({ value, money }: { value: string; money: MoneyText }) {
  if (describeBalance(value).direction !== "credit") return <>{money(value)}</>;
  return (
    <span className="text-mint-ink">
      {money(value)} <span className="text-xs font-semibold">credit</span>
    </span>
  );
}

/** A ledger entry's amount. Which way it points comes from its type, never a sign. */
function EntryAmount({ row, money }: { row: LedgerRow; money: MoneyText }) {
  const type = activityType(row);
  if (type === "statement") return <>—</>;
  if (type === "payment") return <span className="text-mint-ink">{money(row.amount)}</span>;
  if (type === "credit") {
    return (
      <span className="text-mint-ink">
        {money(row.amount)} <span className="text-xs font-semibold">credit</span>
      </span>
    );
  }
  return <>{money(row.amount)}</>;
}

const ENTRY_TYPES: Record<ActivityType, { label: string; tone: BadgeTone }> = {
  statement: { label: "Statement", tone: "closed" },
  invoice: { label: "Invoice", tone: "waiting" },
  payment: { label: "Payment", tone: "good" },
  credit: { label: "Credit", tone: "open" },
  charge: { label: "Extra charge", tone: "waiting" },
};

export const entryType = (row: { type: LedgerRow["type"]; amount: string }) =>
  ENTRY_TYPES[activityType(row)];

/**
 * Ledger entries, newest first: date, type, number, note, amount, what a
 * statement said, and where the entry came from. An invoice's number opens
 * that invoice. With `showSupplier` there is a Supplier column that opens
 * each account; with `running`, the balance after each entry; with `remove`,
 * a button to take a typed-in mistake off.
 */
export function LedgerTable({
  rows,
  money,
  base,
  showSupplier = false,
  running,
  remove,
}: {
  rows: LedgerRow[];
  money: MoneyText;
  /** The Balances tab's own address. */
  base: string;
  showSupplier?: boolean;
  /** The balance after each entry, by entry id. */
  running?: Map<string, HistoryRow>;
  remove?: { slug: string };
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th className={cn(th, "pl-2")}>Date</th>
            {showSupplier && <th className={th}>Supplier</th>}
            <th className={th}>Type</th>
            <th className={th}>Reference</th>
            <th className={th}>Description</th>
            <th className={cn(th, "text-right")}>Amount</th>
            <th className={cn(th, "text-right")}>Stated balance</th>
            {running && <th className={cn(th, "text-right")}>Balance after</th>}
            <th className={th}>Source</th>
            {remove && <th className="w-20 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((row) => {
            const type = entryType(row);
            const after = running?.get(row.id);
            return (
              <tr key={row.id} className={after?.anchor ? "bg-panel" : undefined}>
                <td className={cn(td, "pl-2 whitespace-nowrap")}>{day(row.date, "full")}</td>
                {showSupplier && (
                  <td className={cn(td, "whitespace-nowrap")}>
                    <Link href={`${base}/${row.supplierId}`} className="hover:underline">
                      {row.supplierName}
                    </Link>
                  </td>
                )}
                <td className={td}>
                  <Badge tone={type.tone}>{type.label}</Badge>
                  {after?.current && (
                    <span className="text-muted-foreground mt-0.5 block text-xs whitespace-nowrap">
                      today&apos;s balance starts here
                    </span>
                  )}
                  {after && !after.counted && (
                    <span className="text-muted-foreground mt-0.5 block text-xs whitespace-nowrap">
                      dated ahead: not counted yet
                    </span>
                  )}
                </td>
                <td className={td}>
                  {row.type === "INVOICE" ? (
                    <InvoiceLink base={base} id={row.id} reference={row.reference} />
                  ) : (
                    <span className="font-mono text-[13px]">{row.reference ?? "—"}</span>
                  )}
                </td>
                <td className={cn(td, "font-read text-text-2")}>{row.description || "—"}</td>
                <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                  <EntryAmount row={row} money={money} />
                </td>
                <td className={cn(td, "text-right font-semibold whitespace-nowrap tabular-nums")}>
                  {row.statedBalance === null ? (
                    "—"
                  ) : (
                    <BalanceValue value={row.statedBalance} money={money} />
                  )}
                </td>
                {running && (
                  <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                    {after?.running == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <BalanceValue value={after.running} money={money} />
                    )}
                    {after?.delta && !new Money(after.delta).isZero() && (
                      <span className="text-brick block text-xs">
                        entries came to {money(after.computedBefore ?? "0")}
                      </span>
                    )}
                  </td>
                )}
                <td className={cn(td, "text-muted-foreground text-xs whitespace-nowrap")}>
                  {row.gmailLink ? (
                    <a
                      href={row.gmailLink}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Open the message in Gmail"
                      className="text-ochre-text font-semibold hover:underline"
                    >
                      {sourceLabel(row.source)}
                    </a>
                  ) : (
                    sourceLabel(row.source)
                  )}
                  {row.forwarded && <span className="block">forwarded</span>}
                  {row.needsReview && (
                    <span className="mt-0.5 block">
                      <Badge tone="waiting">To check</Badge>
                    </span>
                  )}
                </td>
                {remove && (
                  <td className="py-1 align-top">
                    <RemoveEntryButton
                      slug={remove.slug}
                      entryId={row.id}
                      what={`the ${type.label.toLowerCase()}${row.reference ? ` ${row.reference}` : ""} of ${day(row.date)}`}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** When a bill is due, in words: late, today, or how long is left. */
export function DueWords({ daysPastDue }: { daysPastDue: number }) {
  const { text, tone } = dueWords(daysPastDue);
  return (
    <span
      className={
        tone === "late"
          ? "text-brick font-semibold"
          : tone === "today"
            ? "text-ochre-text font-semibold"
            : "text-muted-foreground"
      }
    >
      {text}
    </span>
  );
}

/** What's still owed on a bill, with the full amount under it when part is paid. */
export function StillOwed({
  bill,
  money,
}: {
  bill: { open: string; amount: string; partial: boolean };
  money: MoneyText;
}) {
  return (
    <>
      <span className="font-semibold">{money(bill.open)}</span>
      {bill.partial && (
        <span className="text-muted-foreground block text-xs">of {money(bill.amount)}</span>
      )}
    </>
  );
}

/** The "Paid" tick, and how things stand for a bill that has been ticked. */
export function PaidCell({
  slug,
  bill,
  mark,
  timezone,
  canEdit,
}: {
  slug: string;
  bill: { id: string; reference: string | null; paymentSentAt?: string | null };
  mark?: WaitingMark;
  timezone: string;
  canEdit: boolean;
}) {
  const when = mark ? day(localDay(new Date(mark.markedAt), timezone)) : "";
  return (
    <div className="min-w-36">
      <PaidTick
        slug={slug}
        entryId={bill.id}
        checked={Boolean(bill.paymentSentAt)}
        label={`Mark ${bill.reference ?? "this bill"} as paid`}
        disabled={!canEdit}
      />
      {mark && (
        <p
          className={cn(
            "mt-0.5 text-xs",
            mark.state === "waiting" ? "text-mint-ink" : "text-ochre-text font-semibold",
          )}
        >
          {mark.state === "short"
            ? "A payment has been added since you ticked this, but the bill still shows as owed. Check the amount: payments clear the oldest bills first."
            : mark.state === "late"
              ? `Marked paid ${when}, and no payment has been added since.`
              : `Paid ${when} · waiting for the payment to show up`}
        </p>
      )}
    </div>
  );
}

/**
 * "When bills are due": every open bill, grouped by the week it falls due,
 * each week with what's still to pay and what's already been sent.
 */
export function DueTable({
  groups,
  marks,
  money,
  base,
  slug,
  timezone,
  canEdit,
}: {
  groups: DueGroup[];
  marks: Record<string, WaitingMark>;
  money: MoneyText;
  base: string;
  slug: string;
  timezone: string;
  canEdit: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr className="bg-panel">
            <th className={cn(th, "pl-2")}>Due</th>
            <th className={th}>Supplier</th>
            <th className={th}>Invoice</th>
            <th className={th}>Invoiced</th>
            <th className={cn(th, "text-right")}>Still owed</th>
            <th className={cn(th, "pl-3")}>Paid?</th>
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.key} className="divide-border divide-y">
            <tr className={g.overdue ? "bg-brick-soft text-brick" : "bg-panel"}>
              <th
                scope="rowgroup"
                colSpan={4}
                className="py-2 pr-3 pl-2 text-xs font-semibold tracking-wide uppercase"
              >
                {g.label}
              </th>
              <td className="py-2 pr-3 text-right font-bold tabular-nums">{money(g.total)}</td>
              <td className="py-2 pr-3 pl-3 text-xs">
                {new Money(g.paid).gt(0) && (
                  <span className={g.overdue ? undefined : "text-mint-ink"}>
                    + {money(g.paid)} paid
                  </span>
                )}
              </td>
            </tr>
            {g.bills.map((bill) => {
              const payBy = payByHint(bill.dueDate);
              return (
                <tr
                  key={bill.id}
                  className={bill.paymentSentAt ? "text-muted-foreground" : undefined}
                >
                  <td className={cn(td, "pl-2 whitespace-nowrap")}>
                    {weekDay(bill.dueDate)}
                    {payBy && <span className="text-text-2 ml-1.5 text-xs">{payBy}</span>}{" "}
                    <span className="ml-0.5 text-xs">
                      <DueWords daysPastDue={bill.daysPastDue} />
                    </span>
                  </td>
                  <td className={td}>
                    {bill.supplierId ? (
                      <Link href={`${base}/${bill.supplierId}`} className="hover:underline">
                        {bill.vendor}
                      </Link>
                    ) : (
                      bill.vendor
                    )}
                  </td>
                  <td className={td}>
                    <InvoiceLink base={base} id={bill.id} reference={bill.reference} />
                  </td>
                  <td className={cn(td, "whitespace-nowrap")}>{day(bill.date)}</td>
                  <td className={cn(td, "text-right tabular-nums")}>
                    <StillOwed bill={bill} money={money} />
                  </td>
                  <td className={cn(td, "pl-3")}>
                    <PaidCell
                      slug={slug}
                      bill={bill}
                      mark={marks[bill.id]}
                      timezone={timezone}
                      canEdit={canEdit}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

/** One supplier's open bills, oldest first: number, age, when it's due, the tick. */
export function OpenBillsTable({
  bills,
  marks,
  money,
  base,
  slug,
  timezone,
  canEdit,
}: {
  bills: OpenBill[];
  marks: Record<string, WaitingMark>;
  money: MoneyText;
  base: string;
  slug: string;
  timezone: string;
  canEdit: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr className="bg-panel">
            <th className={cn(th, "pl-2")}>Invoice</th>
            <th className={th}>Invoiced</th>
            <th className={cn(th, "text-right")}>Age</th>
            <th className={th}>Due</th>
            <th className={cn(th, "text-right")}>Still owed</th>
            <th className={cn(th, "pl-3")}>Paid?</th>
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {bills.map((bill) => {
            const payBy = payByHint(bill.dueDate);
            return (
              <tr
                key={bill.id}
                className={bill.paymentSentAt ? "text-muted-foreground" : undefined}
              >
                <td className={cn(td, "pl-2")}>
                  <InvoiceLink base={base} id={bill.id} reference={bill.reference} />
                </td>
                <td className={cn(td, "whitespace-nowrap")}>{day(bill.date, "full")}</td>
                <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                  {days(bill.ageDays)}
                </td>
                <td className={cn(td, "whitespace-nowrap")}>
                  {bill.daysPastDue < 0 && `${day(bill.dueDate)} · `}
                  <DueWords daysPastDue={bill.daysPastDue} />
                  {payBy && <span className="text-text-2 ml-1.5 text-xs">{payBy}</span>}
                </td>
                <td className={cn(td, "text-right tabular-nums")}>
                  <StillOwed bill={bill} money={money} />
                </td>
                <td className={cn(td, "pl-3")}>
                  <PaidCell
                    slug={slug}
                    bill={bill}
                    mark={marks[bill.id]}
                    timezone={timezone}
                    canEdit={canEdit}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Bills ticked "Paid" that a payment has since cleared (the last 45 days). */
export function PaymentsConfirmed({
  confirmed,
  money,
  timezone,
  base,
}: {
  confirmed: (ConfirmedMark & { supplier?: string })[];
  money: MoneyText;
  timezone: string;
  base: string;
}) {
  if (confirmed.length === 0) return null;
  return (
    <section className="bg-mint-soft text-mint-ink rounded-xl border border-[var(--tuft-mint)] p-5">
      <h2 className="text-xs font-semibold tracking-wide uppercase">Payments confirmed</h2>
      <ul className="mt-2 flex flex-col gap-1 text-sm">
        {confirmed.map((c) => (
          <li key={c.billId}>
            <span aria-hidden="true">✓ </span>
            {c.supplier ? `${c.supplier} ` : ""}
            <InvoiceLink base={base} id={c.billId} reference={c.reference ?? "invoice"} />{" "}
            <span className="tabular-nums">{money(c.amount)}</span> —{" "}
            {confirmedWords(c, localDay(new Date(c.markedAt), timezone), money)}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Something worth a look, said plainly. With `hide`, a manager can put it
 * away: it stays hidden on every device until its facts change.
 */
export function Note({
  tone = "waiting",
  title,
  children,
  hide,
}: {
  tone?: "waiting" | "bad";
  title: string;
  children: React.ReactNode;
  hide?: { slug: string; noticeKey: string };
}) {
  return (
    <div
      className={cn(
        "font-read flex items-start gap-3 rounded-lg border px-3 py-2 text-sm",
        tone === "bad"
          ? "border-brick/25 bg-brick-soft text-brick"
          : "border-ochre/30 bg-ochre-soft text-ochre-text",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{title}</p>
        {children}
      </div>
      {hide && (
        <form action={setBalanceNotice.bind(null, hide.slug, hide.noticeKey)} className="flex-none">
          <button
            type="submit"
            aria-label={`Hide the notice: ${title}`}
            title="Hide this until something about it changes"
            className="rounded-sm px-1.5 py-0.5 font-sans text-xs font-semibold underline-offset-2 opacity-80 hover:underline hover:opacity-100"
          >
            Hide
          </button>
        </form>
      )}
    </div>
  );
}

/** "2 notices hidden · Show": brings every hidden notice back. */
export function HiddenNotices({ slug, count }: { slug: string; count: number }) {
  if (count === 0) return null;
  return (
    <form
      action={setBalanceNotice.bind(null, slug, null)}
      className="text-muted-foreground flex items-center gap-1 text-xs"
    >
      {count} notice{count === 1 ? "" : "s"} hidden ·
      <button type="submit" className="text-ochre-text font-semibold hover:underline">
        Show
      </button>
    </form>
  );
}

const BUCKETS: { key: AgingBucket; label: string; tone: string }[] = [
  { key: "notDue", label: "Not due yet", tone: "" },
  { key: "late1to30", label: "1–30 days late", tone: "text-ochre-text" },
  { key: "late31to60", label: "31–60 days late", tone: "text-brick" },
  { key: "late60plus", label: "60+ days late", tone: "text-brick" },
];

/** How late the money is: four tiles, each with its amount and how many bills. */
export function AgingTiles({
  buckets,
  money,
}: {
  buckets: AgingResult["buckets"];
  money: MoneyText;
}) {
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {BUCKETS.map(({ key, label: name, tone }) => {
        const bucket = buckets[key];
        const some = bucket.count > 0;
        return (
          <div key={key} className="border-border rounded-lg border px-3 py-2.5">
            <dt className="text-muted-foreground text-xs">{name}</dt>
            <dd
              className={cn(
                "mt-1 text-lg leading-none font-bold tabular-nums",
                some ? tone : "text-muted-foreground opacity-60",
              )}
            >
              {money(bucket.amount)}
            </dd>
            <dd className="text-muted-foreground mt-1.5 text-xs">
              {bucket.count} bill{bucket.count === 1 ? "" : "s"}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** What a member who isn't an owner or admin sees instead of any figures. */
export function ManagersOnly() {
  return (
    <Card>
      <CardContent>
        <p className="text-sm">Only owners and admins can see what&apos;s owed.</p>
      </CardContent>
    </Card>
  );
}
