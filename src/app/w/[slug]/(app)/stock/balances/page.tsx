import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import {
  activityPage,
  balanceQuery,
  filterActivity,
  filterBills,
  isFiltered,
  parseBalanceFilters,
} from "@/lib/stock/balance/activity";
import { Money } from "@/lib/stock/balance/money";
import type { ConfirmedMark, WaitingMark } from "@/lib/stock/balance/paid-marks";
import { combineAging, dueSchedule } from "@/lib/stock/balance/summary";
import { supplierCard, termsHeading } from "@/lib/stock/balance/words";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";
import { loadBalances } from "./data";
import { BalanceFilterBar } from "./filters";
import {
  AgingTiles,
  DueTable,
  LedgerTable,
  ManagersOnly,
  Panel,
  PaymentsConfirmed,
  SupplierCards,
  days,
  moneyText,
} from "./parts";

export const metadata: Metadata = { title: "Supplier balances" };

/**
 * What the workspace owes across every supplier: a card each, every open
 * bill by the week it's due, the ticked bills a payment has since cleared,
 * and every entry on every account. Laid out after the owner's old "Vendor
 * balances" page; each supplier and each invoice opens a page of its own.
 */
export default async function SupplierBalancesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
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
      <StockTabs slug={tenant.slug} tenantId={tenant.id} manager={canManage(role)} />
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

  const filters = parseBalanceFilters(await searchParams);
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

  // The totals, tiles and cards are always the whole picture. Only the two
  // lists (bills and activity) are narrowed by the filters in the address.
  const aging = combineAging(
    started.map((a) => ({ vendor: a.name, supplierId: a.supplierId, aging: a.aging })),
  );
  const allGroups = dueSchedule(aging.bills, today);
  const toPay = allGroups.reduce((sum, g) => sum.add(g.total), new Money(0));
  const paidTotal = allGroups.reduce((sum, g) => sum.add(g.paid), new Money(0));
  const bills = filterBills(aging.bills, filters);
  const groups = dueSchedule(bills, today);
  const narrowed = isFiltered(filters);

  const marks: Record<string, WaitingMark> = {};
  const confirmed: (ConfirmedMark & { supplier: string; supplierId: string })[] = [];
  for (const a of started) {
    for (const w of a.paid.waiting) marks[w.billId] = w;
    for (const c of a.paid.confirmed) {
      confirmed.push({ ...c, supplier: a.name, supplierId: a.supplierId });
    }
  }
  confirmed.sort((x, y) => y.markedAt.localeCompare(x.markedAt));
  const confirmedShown = filters.supplier
    ? confirmed.filter((c) => c.supplierId === filters.supplier)
    : confirmed;

  const everyEntry = started.flatMap((a) => a.ledger);
  const matching = filterActivity(everyEntry, filters);
  const { shown, more } = activityPage(matching, filters);
  const termsDays = aging.termsDays;

  return (
    <>
      {header}

      <SupplierCards
        base={base}
        combined={combined}
        cards={started.map((a) => supplierCard(a.summary))}
        selectedId="all"
        money={money}
      />

      <BalanceFilterBar
        base={base}
        filters={filters}
        suppliers={started.map((a) => ({ id: a.supplierId, name: a.name }))}
      />

      <Panel
        title={`When bills are due · ${termsHeading(termsDays)}`}
        aside={
          allGroups.length === 0 ? (
            <span className="text-muted-foreground">Nothing owed: no open bills.</span>
          ) : paidTotal.gt(0) ? (
            <>
              <strong>{money(toPay.toFixed())} still to pay</strong> ·{" "}
              <span className="text-mint-ink">
                {money(paidTotal.toFixed())} paid, waiting to post
              </span>
            </>
          ) : (
            <>
              {money(aging.openTotal)} open across {aging.bills.length} bill
              {aging.bills.length === 1 ? "" : "s"}
            </>
          )
        }
      >
        <AgingTiles buckets={aging.buckets} money={money} />

        {narrowed && aging.bills.length > 0 && (
          <p className="text-muted-foreground text-xs">
            Showing {bills.length} of {aging.bills.length} open bill
            {aging.bills.length === 1 ? "" : "s"}. The totals above are for everything.{" "}
            <Link href={base} className="text-ochre-text font-semibold hover:underline">
              Show all
            </Link>
          </p>
        )}
        {groups.length > 0 && (
          <DueTable
            groups={groups}
            marks={marks}
            money={money}
            base={base}
            slug={tenant.slug}
            timezone={tenant.timezone}
            canEdit={canEdit}
          />
        )}
        {new Money(aging.unattributed).gt(0) && (
          <p className="text-ochre-text text-xs">
            {money(aging.unattributed)} of what you owe is older than any invoice written down here,
            so we can&apos;t say when it&apos;s due.
          </p>
        )}
        {allGroups.length > 0 && (
          <p className="text-xs print:hidden">
            <a
              href={`${base}/calendar`}
              className="text-ochre-text font-semibold underline-offset-2 hover:underline"
            >
              Put these due dates on my calendar
            </a>{" "}
            <span className="text-muted-foreground">
              (a calendar file: one entry per supplier per pay day. Download it again after things
              change and your calendar updates the same entries.)
            </span>
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          Payments count against each supplier&apos;s oldest bills first, so what&apos;s listed is
          your most recent invoices.{" "}
          {termsDays === null
            ? "A bill is due as many days after its invoice date as its supplier gives you"
            : `A bill is due ${days(termsDays)} after its invoice date`}
          ; one due on a weekend is marked to pay the Friday before, and goes on the calendar file
          that day. Tick <strong>Paid</strong> once you&apos;ve sent the money: the bill stays owed
          until the payment itself is on that supplier&apos;s account, and is then listed as
          confirmed.
        </p>
      </Panel>

      <PaymentsConfirmed
        confirmed={confirmedShown}
        money={money}
        timezone={tenant.timezone}
        base={base}
      />

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[15.5px] leading-snug font-bold tracking-[-0.01em]">
            {narrowed ? "Activity" : "Recent activity"}
          </h2>
          <p className="text-muted-foreground text-xs">
            {narrowed
              ? `${matching.length} of ${everyEntry.length} entries match`
              : more > 0
                ? `The ${shown.length} latest of ${everyEntry.length} entries`
                : `All ${everyEntry.length} entries`}
          </p>
        </div>
        <Card>
          <CardContent className="p-3 sm:p-4">
            {shown.length === 0 ? (
              <p className="text-muted-foreground p-2 text-sm">
                Nothing matches.{" "}
                <Link href={base} className="text-ochre-text font-semibold hover:underline">
                  Clear the filters
                </Link>
              </p>
            ) : (
              <LedgerTable rows={shown} money={money} base={base} showSupplier />
            )}
          </CardContent>
        </Card>
        <p className="text-muted-foreground text-xs">
          {more > 0 && (
            <>
              <Link
                href={`${base}${balanceQuery(filters, { all: true })}`}
                scroll={false}
                className="text-ochre-text font-semibold hover:underline"
              >
                Show everything ({more} more)
              </Link>
              {" · "}
            </>
          )}
          Each supplier&apos;s page has its whole account, its statements and the form to add an
          invoice or payment. Click an invoice number to open that invoice.
        </p>
      </section>

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
