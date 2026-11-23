import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { describeBalance } from "@/lib/stock/balance/format";
import { Money } from "@/lib/stock/balance/money";
import type { ConfirmedMark, WaitingMark } from "@/lib/stock/balance/paid-marks";
import { combineAging, dueSchedule } from "@/lib/stock/balance/summary";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";
import { loadBalances } from "./data";
import {
  DueWords,
  LedgerTable,
  ManagersOnly,
  PaidCell,
  PaymentsConfirmed,
  StillOwed,
  day,
  days,
  moneyText,
  td,
  th,
} from "./parts";

export const metadata: Metadata = { title: "Supplier balances" };

const RECENT = 12;

/** What the workspace owes across every supplier, and when each bill is due. */
export default async function SupplierBalancesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/balances`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const base = `/w/${tenant.slug}/stock/balances`;
  const header = (
    <>
      <PageHeader
        title="Stock"
        description="Supplier balances: what you owe each supplier, and when each bill is due."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />
    </>
  );
  if (!canManage(role)) {
    return (
      <>
        {header}
        <ManagersOnly />
      </>
    );
  }

  const { accounts, combined, today } = await loadBalances(await createClient(), tenant);
  const money = moneyText(tenant.currency);
  const canEdit = entitlements.canWrite;
  const started = accounts.filter((a) => a.ledger.length > 0);
  const notStarted = accounts.filter((a) => a.ledger.length === 0 && !a.archived);

  if (accounts.length === 0) {
    return (
      <>
        {header}
        <Card>
          <CardHeader>
            <CardTitle>No suppliers yet</CardTitle>
            <CardDescription>
              Add the people you buy from first, then keep track of what you owe them here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={`/w/${tenant.slug}/stock/suppliers`}
              className="text-ochre-text text-sm font-semibold hover:underline"
            >
              Go to Suppliers
            </Link>
          </CardContent>
        </Card>
      </>
    );
  }

  const aging = combineAging(started.map((a) => ({ vendor: a.name, aging: a.aging })));
  const groups = dueSchedule(aging.bills, today);
  const toPay = groups.reduce((sum, g) => sum.add(g.total), new Money(0));
  const paidTotal = groups.reduce((sum, g) => sum.add(g.paid), new Money(0));
  const marks: Record<string, WaitingMark> = {};
  const confirmed: (ConfirmedMark & { supplier: string })[] = [];
  for (const a of started) {
    for (const w of a.paid.waiting) marks[w.billId] = w;
    for (const c of a.paid.confirmed) confirmed.push({ ...c, supplier: a.name });
  }
  confirmed.sort((x, y) => y.markedAt.localeCompare(x.markedAt));
  const recent = started
    .flatMap((a) => a.ledger)
    .sort((x, y) => y.date.localeCompare(x.date) || y.createdAt.localeCompare(x.createdAt))
    .slice(0, RECENT);
  const startLinks = notStarted.length > 0 && (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
      {notStarted.map((a) => (
        <li key={a.supplierId}>
          <Link
            href={`${base}/${a.supplierId}`}
            className="text-ochre-text font-semibold hover:underline"
          >
            {a.name}
          </Link>
        </li>
      ))}
    </ul>
  );

  if (started.length === 0) {
    return (
      <>
        {header}
        <Card>
          <CardHeader>
            <CardTitle>Nothing written down yet</CardTitle>
            <CardDescription>
              Pick a supplier and add their open invoices, or the balance from their latest
              statement. From then on this page shows what you owe and when it&apos;s due.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {startLinks || (
              <p className="text-muted-foreground text-sm">
                Every supplier here is marked as not used any more.
              </p>
            )}
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <>
      {header}

      <Card>
        <CardContent className="flex flex-col gap-1">
          <p className="text-muted-foreground text-xs font-semibold">Total due · all suppliers</p>
          <p className="text-3xl leading-tight font-bold tabular-nums">{money(combined.owed)}</p>
          <p className="text-sm">
            {new Money(combined.overdue).gt(0) ? (
              <>
                <span className="text-brick font-semibold">{money(combined.overdue)} past due</span>{" "}
                <span className="text-muted-foreground">
                  ({combined.overdueBills} bill{combined.overdueBills === 1 ? "" : "s"})
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Nothing past due</span>
            )}
          </p>
          {new Money(combined.markedPaid).gt(0) && (
            <p className="text-mint-ink text-sm">
              {money(combined.markedPaid)} of it already paid, waiting for the payment to show up
            </p>
          )}
          {new Money(combined.credit).gt(0) && (
            <p className="text-mint-ink text-sm">
              Plus {money(combined.credit)} credit in your favour. A credit with one supplier
              isn&apos;t taken off what you owe another.
            </p>
          )}
        </CardContent>
      </Card>

      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {started.map(({ summary: s }) => {
          const balance = describeBalance(s.balance);
          return (
            <li key={s.supplierId}>
              <Link
                href={`${base}/${s.supplierId}`}
                className="border-border bg-card hover:bg-hover flex h-full flex-col gap-1 rounded-xl border p-5 transition-colors duration-150"
              >
                <span className="truncate text-sm font-semibold">{s.name}</span>
                <span className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "text-2xl leading-tight font-bold tabular-nums",
                      balance.direction === "credit" && "text-mint-ink",
                    )}
                  >
                    {money(s.balance)}
                  </span>
                  {balance.direction === "credit" && <Badge tone="good">Credit</Badge>}
                </span>
                <span className="text-sm">
                  {new Money(s.overdue).gt(0) ? (
                    <span className="text-brick font-semibold">{money(s.overdue)} past due</span>
                  ) : s.oldest ? (
                    <span className="text-muted-foreground">
                      Oldest unpaid {s.oldest.reference ?? "bill"} due {day(s.oldest.dueDate)}
                    </span>
                  ) : balance.direction === "settled" ? (
                    <span className="text-muted-foreground">Paid up</span>
                  ) : null}
                </span>
                {new Money(s.markedPaid).gt(0) && (
                  <span className="text-mint-ink text-xs">
                    {money(s.markedPaid)} paid, waiting to show up
                  </span>
                )}
                <span className="text-muted-foreground text-xs">
                  {days(s.termsDays)} to pay each invoice
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <Card>
        <CardHeader>
          <CardTitle>When bills are due</CardTitle>
          <CardDescription>
            {groups.length === 0 ? (
              "Nothing owed: no open bills."
            ) : paidTotal.gt(0) ? (
              <>
                {money(toPay.toFixed())} still to pay · {money(paidTotal.toFixed())} paid, waiting
                to show up
              </>
            ) : (
              <>
                {money(aging.openTotal)} open across {aging.bills.length} bill
                {aging.bills.length === 1 ? "" : "s"}
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {groups.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className={cn(th, "pl-2")}>Due</th>
                    <th className={th}>Supplier</th>
                    <th className={th}>Invoice</th>
                    <th className={th}>Invoiced</th>
                    <th className={cn(th, "text-right")}>Still owed</th>
                    <th className={th}>Paid?</th>
                  </tr>
                </thead>
                {groups.map((g) => (
                  <tbody key={g.key} className="divide-border divide-y">
                    <tr className={g.overdue ? "bg-brick-soft text-brick" : "bg-panel"}>
                      <th scope="rowgroup" colSpan={4} className="py-2 pr-3 pl-2 text-xs">
                        {g.label}
                      </th>
                      <td className="py-2 pr-3 text-right font-bold tabular-nums">
                        {money(g.total)}
                      </td>
                      <td className="py-2 pr-3 text-xs">
                        {new Money(g.paid).gt(0) && (
                          <span className={g.overdue ? undefined : "text-mint-ink"}>
                            + {money(g.paid)} paid
                          </span>
                        )}
                      </td>
                    </tr>
                    {g.bills.map((bill) => (
                      <tr
                        key={bill.id}
                        className={bill.paymentSentAt ? "text-muted-foreground" : undefined}
                      >
                        <td className={cn(td, "pl-2 whitespace-nowrap")}>
                          {day(bill.dueDate, "weekday")}{" "}
                          <span className="text-xs">
                            <DueWords daysPastDue={bill.daysPastDue} />
                          </span>
                        </td>
                        <td className={td}>{bill.vendor}</td>
                        <td className={cn(td, "font-read")}>{bill.reference ?? "—"}</td>
                        <td className={cn(td, "whitespace-nowrap")}>{day(bill.date)}</td>
                        <td className={cn(td, "text-right tabular-nums")}>
                          <StillOwed bill={bill} money={money} />
                        </td>
                        <td className={td}>
                          <PaidCell
                            slug={tenant.slug}
                            bill={bill}
                            mark={marks[bill.id]}
                            timezone={tenant.timezone}
                            canEdit={canEdit}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
          {new Money(aging.unattributed).gt(0) && (
            <p className="text-ochre-text text-xs">
              {money(aging.unattributed)} of what you owe is older than any invoice written down
              here, so we can&apos;t say when it&apos;s due.
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            Payments count against each supplier&apos;s oldest bills first, so what&apos;s listed is
            your most recent invoices. Tick &quot;Paid&quot; once you&apos;ve sent the money: the
            bill stays owed until the payment itself is added to that supplier&apos;s account, and
            is then listed as confirmed.
          </p>
        </CardContent>
      </Card>

      <PaymentsConfirmed confirmed={confirmed} money={money} timezone={tenant.timezone} />

      <Card>
        <CardHeader>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>
            The {RECENT} latest entries across your suppliers. Open a supplier to see their whole
            account and add an invoice or payment.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LedgerTable rows={recent} money={money} linkBase={base} />
        </CardContent>
      </Card>

      {startLinks && (
        <Card>
          <CardHeader>
            <CardTitle>Start an account</CardTitle>
            <CardDescription>
              Nothing is written down for these suppliers yet. Open one to add its first invoice.
            </CardDescription>
          </CardHeader>
          <CardContent>{startLinks}</CardContent>
        </Card>
      )}
    </>
  );
}
