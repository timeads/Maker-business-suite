import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { describeAdjustment, describeBalance } from "@/lib/stock/balance/format";
import { Money } from "@/lib/stock/balance/money";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { stockAccess } from "../../gate";
import { loadBalances } from "../data";
import { EntryForm, TermsForm } from "../forms";
import {
  BalanceValue,
  DueWords,
  LedgerTable,
  ManagersOnly,
  Note,
  PaidCell,
  PaymentsConfirmed,
  StillOwed,
  day,
  days,
  moneyText,
  td,
  th,
} from "../parts";

export const metadata: Metadata = { title: "Supplier balance" };

/** A statement older than this is worth asking the supplier to refresh. */
const STALE_DAYS = 35;

/** One supplier's account: the balance, open bills, the add-entry form and every entry. */
export default async function SupplierBalancePage({
  params,
}: {
  params: Promise<{ slug: string; supplierId: string }>;
}) {
  const { slug, supplierId } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/balances/${supplierId}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const back = { href: `/w/${tenant.slug}/stock/balances`, label: "Supplier balances" };
  if (!canManage(role)) {
    return (
      <>
        <PageHeader back={back} title="Supplier balance" />
        <ManagersOnly />
      </>
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(supplierId)) notFound();

  const { accounts, today } = await loadBalances(await createClient(), tenant, supplierId);
  const account = accounts[0];
  if (!account) notFound();
  const money = moneyText(tenant.currency);
  const canEdit = entitlements.canWrite;
  const { balance: b, aging, paid, audits, name } = account;
  const empty = account.ledger.length === 0;
  const owed = describeBalance(b.estimatedBalance);
  const drifted = audits.filter((a) => !new Money(a.delta).isZero()).reverse();
  const stale = b.daysSinceStatement !== null && b.daysSinceStatement > STALE_DAYS;
  const marks = Object.fromEntries(paid.waiting.map((w) => [w.billId, w]));
  const oldest = aging.bills[0];
  const heroLabel = empty
    ? "Nothing written down yet"
    : !b.anchor
      ? "Estimated balance"
      : owed.direction === "credit"
        ? `Credit with ${name}`
        : owed.direction === "settled"
          ? "Account settled"
          : `You owe ${name}`;

  return (
    <>
      <PageHeader
        back={back}
        title={name}
        description={`What you owe ${name}. Each invoice is due ${days(account.termsDays)} after its date.`}
      >
        {account.archived && <Badge>Not used any more</Badge>}
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1">
            <p className="text-muted-foreground text-xs font-semibold">{heroLabel}</p>
            <p className="flex flex-wrap items-center gap-2">
              <span
                className={cn(
                  "text-3xl leading-tight font-bold tabular-nums",
                  owed.direction === "credit" && "text-mint-ink",
                )}
              >
                {money(b.estimatedBalance)}
              </span>
              {owed.direction === "credit" && <Badge tone="good">Credit</Badge>}
              {owed.direction === "owed" && !b.anchor && <Badge tone="waiting">Owed</Badge>}
            </p>
            {owed.direction === "credit" && (
              <p className="text-mint-ink text-xs">
                You&apos;ve paid more than you&apos;ve been billed. This much is in your favour.
              </p>
            )}
            <p className="text-muted-foreground font-read text-xs">
              {empty ? (
                "Add their open invoices, or the balance from their latest statement, below."
              ) : b.anchor ? (
                <>
                  From {name}&apos;s statement of {day(b.anchor.date, "full")} (
                  {money(b.anchor.statedBalance)}
                  {describeBalance(b.anchor.statedBalance).direction === "credit" ? " credit" : ""}
                  ), plus what&apos;s happened since.
                </>
              ) : (
                "No statement from them yet, so this is your invoices less your payments."
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>Since the last statement</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Last stated</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {b.anchor ? <BalanceValue value={b.anchor.statedBalance} money={money} /> : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">+ New invoices</dt>
                <dd className="text-lg font-semibold tabular-nums">{money(b.invoicesSince)}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">− Payments sent</dt>
                <dd className="text-mint-ink text-lg font-semibold tabular-nums">
                  {money(b.paymentsSince)}
                </dd>
              </div>
            </dl>
            {!new Money(b.adjustmentsSince).isZero() && (
              <p className="text-sm">
                Adjustments: {money(b.adjustmentsSince)}
                {describeAdjustment(b.adjustmentsSince).isCredit ? " credit" : " added"}
              </p>
            )}
            {b.daysSinceStatement !== null && (
              <p className="text-muted-foreground text-xs">
                {b.daysSinceStatement === 0
                  ? "The last statement is dated today."
                  : `The last statement was ${days(b.daysSinceStatement)} ago.`}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {!empty && (
        <Card>
          <CardHeader>
            <CardTitle>Open bills</CardTitle>
            <CardDescription>
              {oldest ? (
                <span className={oldest.daysPastDue > 0 ? "text-brick font-semibold" : undefined}>
                  Oldest unpaid: {oldest.reference ?? "an invoice"}, invoiced {day(oldest.date)},{" "}
                  {days(oldest.ageDays)} ago,{" "}
                  {oldest.daysPastDue > 0
                    ? `${days(oldest.daysPastDue)} past due`
                    : `due ${day(oldest.dueDate)}`}
                </span>
              ) : new Money(aging.unattributed).gt(0) ? (
                "No invoices on the account match what's owed."
              ) : (
                "Nothing owed: no open bills."
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {aging.bills.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="text-muted-foreground text-xs">
                    <tr>
                      <th className={th}>Invoice</th>
                      <th className={th}>Invoiced</th>
                      <th className={cn(th, "text-right")}>Age</th>
                      <th className={th}>Due</th>
                      <th className={cn(th, "text-right")}>Still owed</th>
                      <th className={th}>Paid?</th>
                    </tr>
                  </thead>
                  <tbody className="divide-border divide-y">
                    {aging.bills.map((bill) => (
                      <tr
                        key={bill.id}
                        className={bill.paymentSentAt ? "text-muted-foreground" : undefined}
                      >
                        <td className={cn(td, "font-read")}>{bill.reference ?? "—"}</td>
                        <td className={cn(td, "whitespace-nowrap")}>{day(bill.date, "full")}</td>
                        <td className={cn(td, "text-right whitespace-nowrap tabular-nums")}>
                          {days(bill.ageDays)}
                        </td>
                        <td className={cn(td, "whitespace-nowrap")}>
                          {bill.daysPastDue < 0 && `${day(bill.dueDate)} · `}
                          <DueWords daysPastDue={bill.daysPastDue} />
                        </td>
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
                </table>
              </div>
            )}
            {new Money(aging.unattributed).gt(0) && (
              <p className="text-ochre-text text-xs">
                {money(aging.unattributed)} of the balance is older than any invoice written down
                here, so we can&apos;t say how old it is.
              </p>
            )}
            <p className="text-muted-foreground text-xs">
              You pay against a running balance, so each payment counts against your oldest bills
              first. What&apos;s still owed is your most recent invoices, each due{" "}
              {days(aging.termsDays)} after the date on it.
            </p>
          </CardContent>
        </Card>
      )}

      <PaymentsConfirmed confirmed={paid.confirmed} money={money} timezone={tenant.timezone} />

      {stale && (
        <Note title="Their statement is getting old">
          <p>
            The last statement from {name} is {days(b.daysSinceStatement ?? 0)} old. Anything
            they&apos;ve billed since only counts if it has been added here, so you may owe more
            than this shows. Ask them for a fresh statement and add its balance.
          </p>
        </Note>
      )}

      {drifted.length > 0 && (
        <Note tone="bad" title="A statement doesn't add up with what's written down here">
          <ul className="flex flex-col gap-0.5">
            {drifted.map((a) => {
              const delta = new Money(a.delta);
              return (
                <li key={a.toDate}>
                  Statement of {day(a.toDate, "full")}: {name} says{" "}
                  <BalanceWords value={a.statedBalance} money={money} />, your entries come to{" "}
                  <BalanceWords value={a.computedBalance} money={money} />.{" "}
                  <strong>
                    Their figure is {money(a.delta)} {delta.gt(0) ? "higher" : "lower"}.
                  </strong>
                </li>
              );
            })}
          </ul>
          <p className="mt-1">
            An invoice or payment missing from between two statements is the usual reason.
          </p>
        </Note>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Add to {name}&apos;s account</CardTitle>
          </CardHeader>
          <CardContent>
            <EntryForm key={supplierId} slug={tenant.slug} supplierId={supplierId} today={today} />
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Time to pay</CardTitle>
            <CardDescription>
              How long {name} gives you to pay an invoice. Due dates are worked out from this.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <TermsForm slug={tenant.slug} supplierId={supplierId} days={account.termsDays} />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Ledger</CardTitle>
          <CardDescription>
            Their latest statement is taken as the true balance on its date. Invoices and payments
            dated after it are added and taken off, so an old slip can&apos;t linger: each new
            statement sets the account straight.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {empty ? (
            <p className="text-muted-foreground text-sm">No entries yet.</p>
          ) : (
            <LedgerTable
              rows={account.ledger}
              money={money}
              remove={canEdit ? { slug: tenant.slug } : undefined}
            />
          )}
        </CardContent>
      </Card>
    </>
  );
}

/** "$120.00 owed", "$120.00 credit" or "$0.00": a balance with its direction in words. */
function BalanceWords({ value, money }: { value: string; money: (v: string) => string }) {
  const { direction } = describeBalance(value);
  return (
    <>
      {money(value)}
      {direction === "settled" ? "" : ` ${direction}`}
    </>
  );
}
