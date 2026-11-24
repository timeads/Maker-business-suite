import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { localDay } from "@/lib/bookings/slots";
import type { LedgerType } from "@/lib/stock/balance/balance";
import { describeAdjustment, describeBalance } from "@/lib/stock/balance/format";
import { Money } from "@/lib/stock/balance/money";
import type { ConfirmedMark, WaitingMark } from "@/lib/stock/balance/paid-marks";
import { cn } from "@/lib/utils";
import type { AgingBucket, AgingResult } from "@/lib/stock/balance/aging";
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

export const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

export const th = "py-2 pr-3 font-semibold";
export const td = "py-2 pr-3 align-top";

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
  if (row.type === "STATEMENT") return <>—</>;
  if (row.type === "PAYMENT") return <span className="text-mint-ink">{money(row.amount)}</span>;
  if (row.type === "ADJUSTMENT" && describeAdjustment(row.amount).isCredit) {
    return (
      <span className="text-mint-ink">
        {money(row.amount)} <span className="text-xs font-semibold">credit</span>
      </span>
    );
  }
  return <>{money(row.amount)}</>;
}

function entryType(row: LedgerRow): { label: string; tone: BadgeTone } {
  const types: Record<LedgerType, { label: string; tone: BadgeTone }> = {
    STATEMENT: { label: "Statement", tone: "closed" },
    INVOICE: { label: "Invoice", tone: "waiting" },
    PAYMENT: { label: "Payment", tone: "good" },
    ADJUSTMENT: describeAdjustment(row.amount).isCredit
      ? { label: "Credit", tone: "open" }
      : { label: "Extra charge", tone: "waiting" },
  };
  return types[row.type];
}

/** Entries newest first. `linkBase` adds a Supplier column that opens each account. */
export function LedgerTable({
  rows,
  money,
  linkBase,
  remove,
}: {
  rows: LedgerRow[];
  money: MoneyText;
  linkBase?: string;
  /** Offer "Remove" on each row. */
  remove?: { slug: string };
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-muted-foreground text-xs">
          <tr>
            <th className={th}>Date</th>
            {linkBase && <th className={th}>Supplier</th>}
            <th className={th}>Type</th>
            <th className={th}>Reference</th>
            <th className={th}>Description</th>
            <th className={cn(th, "text-right")}>Amount</th>
            <th className={cn(th, "text-right")}>Stated balance</th>
            {remove && <th className="w-20 py-2" />}
          </tr>
        </thead>
        <tbody className="divide-border divide-y">
          {rows.map((row) => {
            const type = entryType(row);
            return (
              <tr key={row.id}>
                <td className={cn(td, "whitespace-nowrap")}>{day(row.date, "full")}</td>
                {linkBase && (
                  <td className={td}>
                    <Link href={`${linkBase}/${row.supplierId}`} className="hover:underline">
                      {row.supplierName}
                    </Link>
                  </td>
                )}
                <td className={td}>
                  <Badge tone={type.tone}>{type.label}</Badge>
                  {row.fromBooks && (
                    <span className="text-muted-foreground mt-0.5 block text-xs whitespace-nowrap">
                      from your books
                    </span>
                  )}
                </td>
                <td className={cn(td, "font-read")}>{row.reference ?? "—"}</td>
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
  if (daysPastDue > 0) {
    return <span className="text-brick font-semibold">{days(daysPastDue)} late</span>;
  }
  if (daysPastDue === 0) return <span className="text-ochre-text font-semibold">today</span>;
  return <span className="text-muted-foreground">in {days(-daysPastDue)}</span>;
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
              : `Marked paid ${when}. Waiting for the payment to show up.`}
        </p>
      )}
    </div>
  );
}

/** Bills ticked "Paid" that a payment has since cleared (the last 45 days). */
export function PaymentsConfirmed({
  confirmed,
  money,
  timezone,
}: {
  confirmed: (ConfirmedMark & { supplier?: string })[];
  money: MoneyText;
  timezone: string;
}) {
  if (confirmed.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Payments confirmed</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-1.5 text-sm">
          {confirmed.map((c) => (
            <li key={c.billId} className="flex flex-wrap items-baseline gap-x-2">
              <Badge tone="good">Cleared</Badge>
              <span>
                {c.supplier ? `${c.supplier} · ` : ""}
                <span className="font-read">{c.reference ?? "an invoice"}</span> ·{" "}
                <span className="tabular-nums">{money(c.amount)}</span>
                <span className="text-muted-foreground">
                  {" "}
                  — you marked it paid {day(localDay(new Date(c.markedAt), timezone))}
                  {c.payment
                    ? `, and the ${money(c.payment.amount)} payment of ${day(c.payment.date)} cleared it`
                    : ", and it's no longer owed"}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
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

/** "2 notices hidden · Show them": brings every hidden notice back. */
export function HiddenNotices({ slug, count }: { slug: string; count: number }) {
  if (count === 0) return null;
  return (
    <form
      action={setBalanceNotice.bind(null, slug, null)}
      className="text-muted-foreground flex items-center gap-1 text-xs"
    >
      {count} notice{count === 1 ? "" : "s"} hidden ·
      <button type="submit" className="text-ochre-text font-semibold hover:underline">
        Show {count === 1 ? "it" : "them"}
      </button>
    </form>
  );
}

const BUCKETS: { key: AgingBucket; label: string; tone: string }[] = [
  { key: "notDue", label: "Not due yet", tone: "" },
  { key: "late1to30", label: "1–30 days late", tone: "text-ochre-text" },
  { key: "late31to60", label: "31–60 days late", tone: "text-brick" },
  { key: "late60plus", label: "Over 60 days late", tone: "text-brick" },
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
      {BUCKETS.map(({ key, label, tone }) => {
        const bucket = buckets[key];
        const some = bucket.count > 0;
        return (
          <div key={key} className="bg-card border-border rounded-lg border px-4 py-3">
            <dt className="text-muted-foreground text-xs font-semibold">{label}</dt>
            <dd
              className={cn(
                "mt-1 text-xl leading-none font-bold tabular-nums",
                some ? tone : "text-muted-foreground",
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
