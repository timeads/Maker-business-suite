import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { localDay } from "@/lib/bookings/slots";
import { describeAdjustment, describeBalance } from "@/lib/stock/balance/format";
import { Money } from "@/lib/stock/balance/money";
import { balanceNotices } from "@/lib/stock/balance/notices";
import { arrivalWords, lastArrival, supplierCard } from "@/lib/stock/balance/words";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { stockAccess } from "../../gate";
import { loadBalances } from "../data";
import { EntryForm, TermsForm } from "../forms";
import { loadMailFacts } from "../mail-data";
import { UploadBillForm } from "../mail-forms";
import { MailNotices, ToCheckList, mailNoticesFor } from "../mail-parts";
import {
  AgingTiles,
  BalanceValue,
  HiddenNotices,
  InvoiceLink,
  LedgerTable,
  ManagersOnly,
  Note,
  OpenBillsTable,
  Panel,
  PaymentsConfirmed,
  SupplierCards,
  day,
  days,
  label,
  moment,
  moneyText,
} from "../parts";

export const metadata: Metadata = { title: "Supplier balance" };

/** A statement older than this is worth asking the supplier to refresh. */
const STALE_DAYS = 35;

const summaryButton =
  "border-input bg-card hover:bg-hover inline-flex h-9 w-fit cursor-pointer items-center rounded-sm border px-3.5 text-sm font-semibold select-none";

/**
 * One supplier's account, laid out like the main Balances page narrowed to
 * that supplier: the same cards on top, what's owed and what happened since
 * their last statement, the open bills, then every entry with the balance
 * after it, the statements, and which bills each payment cleared.
 */
export default async function SupplierBalancePage({
  params,
}: {
  params: Promise<{ slug: string; supplierId: string }>;
}) {
  const { slug, supplierId } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/balances/${supplierId}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const base = `/w/${tenant.slug}/stock/balances`;
  const back = { href: base, label: "All suppliers & due dates" };
  if (!canManage(role)) {
    return (
      <>
        <PageHeader back={back} title="Supplier balances" />
        <ManagersOnly />
      </>
    );
  }
  if (!/^[0-9a-f-]{36}$/i.test(supplierId)) notFound();

  const supabase = await createClient();
  const [{ accounts, combined, today, hiddenNotices, booksOn }, mail] = await Promise.all([
    loadBalances(supabase, tenant),
    loadMailFacts(supabase, tenant),
  ]);
  const account = accounts.find((a) => a.supplierId === supplierId.toLowerCase());
  if (!account) notFound();
  const money = moneyText(tenant.currency);
  const canEdit = entitlements.canWrite;
  const { balance: b, aging, paid, audits, name, history } = account;
  const empty = account.ledger.length === 0;
  const owed = describeBalance(b.estimatedBalance);
  const drifted = audits.filter((a) => !new Money(a.delta).isZero()).reverse();
  const stale = b.daysSinceStatement !== null && b.daysSinceStatement > STALE_DAYS;
  // Each notice's key carries its facts, so one that was hidden comes back
  // when a newer statement or another payment changes them.
  const notices = balanceNotices(
    {
      supplierId: account.supplierId,
      anchorDate: b.anchor?.date ?? null,
      stale,
      unreflectedIds: b.paymentsPossiblyUnreflected.map((p) => p.id),
      drifted: drifted.map((a) => ({ toDate: a.toDate, delta: a.delta })),
    },
    hiddenNotices,
  );
  const notice = (kind: "stale" | "unreflected" | "drift") => {
    const found = notices.find((n) => n.kind === kind && !n.hidden);
    return found && canEdit ? { slug: tenant.slug, noticeKey: found.key } : undefined;
  };
  const shows = (kind: "stale" | "unreflected" | "drift") =>
    notices.some((n) => n.kind === kind && !n.hidden);
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
  const started = accounts.filter((a) => a.ledger.length > 0 || a.supplierId === supplierId);
  const running = new Map(history.rows.map((row) => [row.id, row]));
  const statements = history.rows.filter((row) => row.anchor).reverse();
  const stated = new Map(account.ledger.map((row) => [row.id, row.statedBalance]));
  const payments = [...history.payments].reverse();
  const toCheck = account.ledger.filter((row) => row.needsReview);
  const quietNotices = mailNoticesFor(mail, [account], today, hiddenNotices).filter(
    (n) => n.kind === "payments-quiet",
  );
  const mailOn = mail.readingOn || mail.bills !== null;
  const listed =
    mail.sources.suppliers.some((s) => s.supplier_id === account.supplierId) ||
    mail.sources.bank.some((b) => b.payees.some((p) => p.supplier_id === account.supplierId));
  const lastEmail = lastArrival(account.ledger, "email");
  const lastBooks = lastArrival(account.ledger, "books");
  const lastImport = lastArrival(account.ledger, "import");

  return (
    <>
      <PageHeader back={back} title="Supplier balances">
        {account.archived && <Badge>Not used any more</Badge>}
      </PageHeader>

      <SupplierCards
        base={base}
        combined={combined}
        cards={started.map((a) => supplierCard(a.summary))}
        selectedId={account.supplierId}
        money={money}
      />

      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg leading-snug font-bold tracking-[-0.01em]">
          {name} — account balance
        </h2>
        <p className="text-muted-foreground text-xs">
          Net {account.termsDays} · {tenant.currency}
          {account.updatedAt &&
            ` · updated ${day(localDay(new Date(account.updatedAt), tenant.timezone), "full")}`}
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1">
            <p className={label}>{heroLabel}</p>
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
            <p className="text-muted-foreground font-read mt-1 text-xs">
              {empty ? (
                "Add their open invoices, or the balance from their latest statement, below."
              ) : b.anchor ? (
                <>
                  From {name}&apos;s statement of {day(b.anchor.date, "full")} (
                  <BalanceWords value={b.anchor.statedBalance} money={money} />
                  ), plus activity since.
                </>
              ) : (
                "No statement from them yet, so this is your invoices less your payments."
              )}
            </p>
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardContent className="flex flex-col gap-3">
            <p className={label}>Since the last statement</p>
            <dl className="grid grid-cols-3 gap-4 text-sm">
              <div>
                <dt className="text-muted-foreground text-xs">Last stated</dt>
                <dd className="text-lg font-semibold tabular-nums">
                  {b.anchor ? <BalanceValue value={b.anchor.statedBalance} money={money} /> : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs">+ New invoices</dt>
                <dd className="text-ochre-text text-lg font-semibold tabular-nums">
                  {money(b.invoicesSince)}
                </dd>
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
                  ? "Last statement is dated today."
                  : `Last statement was ${days(b.daysSinceStatement)} ago.`}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {shows("unreflected") && (
        <Note
          title={
            b.paymentsPossiblyUnreflected.length === 1
              ? "A payment may not be in their statement yet"
              : "Some payments may not be in their statement yet"
          }
          hide={notice("unreflected")}
        >
          <ul className="flex flex-col gap-0.5">
            {b.paymentsPossiblyUnreflected.map((p) => (
              <li key={p.id}>
                {money(p.amount)} paid {day(p.date, "full")}
                {p.reference ? ` (${p.reference})` : ""}: sent shortly before the statement&apos;s
                date, so {name} may not have counted it.
              </li>
            ))}
          </ul>
          <p className="mt-1">
            {b.paymentsPossiblyUnreflected.length === 1 ? "It isn't" : "These aren't"} taken off the
            balance above, so nothing is counted twice. Check with {name}; their next statement will
            settle it.
          </p>
        </Note>
      )}

      {!empty && (
        <Panel
          title={`Open bills · net ${aging.termsDays}`}
          aside={
            oldest ? (
              <span className={oldest.daysPastDue > 0 ? "text-brick font-semibold" : "text-text-2"}>
                Oldest unpaid: {oldest.reference ?? "an invoice"}, invoiced {day(oldest.date)},{" "}
                {days(oldest.ageDays)} ago —{" "}
                {oldest.daysPastDue > 0
                  ? `${days(oldest.daysPastDue)} past due`
                  : `due ${day(oldest.dueDate)}`}
              </span>
            ) : new Money(aging.unattributed).gt(0) ? (
              <span className="text-muted-foreground">
                No invoices on the account match what&apos;s owed.
              </span>
            ) : (
              <span className="text-muted-foreground">Nothing owed: no open bills.</span>
            )
          }
        >
          <AgingTiles buckets={aging.buckets} money={money} />
          {aging.bills.length > 0 && (
            <OpenBillsTable
              bills={aging.bills}
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
              {money(aging.unattributed)} of the balance is older than any invoice written down
              here, so we can&apos;t say how old it is.
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            You pay against a running balance, so each payment is counted against your oldest bills
            first: what&apos;s still owed is your most recent invoices. Each is due{" "}
            {days(aging.termsDays)} after the date printed on the invoice.
          </p>
        </Panel>
      )}

      <PaymentsConfirmed
        confirmed={paid.confirmed}
        money={money}
        timezone={tenant.timezone}
        base={base}
      />

      {shows("stale") && (
        <Note title="Their statement is getting old" hide={notice("stale")}>
          <p>
            The last statement from {name} is {days(b.daysSinceStatement ?? 0)} old. Anything
            they&apos;ve billed since only counts if it has been added here, so you may owe more
            than this shows. Ask them for a fresh statement and add its balance.
          </p>
        </Note>
      )}

      {shows("drift") && (
        <Note
          tone="bad"
          title="A statement doesn't add up with what's written down here"
          hide={notice("drift")}
        >
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

      <MailNotices
        notices={quietNotices}
        names={new Map([[account.supplierId, name]])}
        slug={tenant.slug}
        base={base}
        timezone={tenant.timezone}
        canEdit={canEdit}
      />

      {toCheck.length > 0 && (
        <Panel
          title={`${toCheck.length} to check`}
          aside={
            <span className="text-muted-foreground text-xs">
              Read from email or a file, with something unclear
            </span>
          }
        >
          <ToCheckList
            rows={toCheck}
            slug={tenant.slug}
            base={base}
            money={money}
            canEdit={canEdit}
            showSupplier={false}
          />
        </Panel>
      )}

      {canEdit && (
        <HiddenNotices
          slug={tenant.slug}
          count={
            notices.filter((n) => n.hidden).length + quietNotices.filter((n) => n.hidden).length
          }
        />
      )}

      <Card>
        <CardContent className="flex flex-col gap-1.5 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-semibold">How entries get here</h2>
            <p className="text-muted-foreground text-xs">
              {[
                lastEmail &&
                  `Last filed from email ${moment(lastEmail.at, tenant.timezone)} · ${lastEmail.count} new`,
                lastBooks &&
                  `Last filed from your books ${moment(lastBooks.at, tenant.timezone)} · ${lastBooks.count} new`,
                lastImport &&
                  `Last spreadsheet import ${moment(lastImport.at, tenant.timezone)} · ${lastImport.count} ${lastImport.count === 1 ? "entry" : "entries"}`,
              ]
                .filter(Boolean)
                .join(" · ") || "Everything here so far was typed in"}
            </p>
          </div>
          {arrivalWords(name, {
            booksOn,
            lastBooks,
            lastImport,
            mail: { forwarding: mail.bills !== null, reading: mail.readingOn, listed },
          }).map((line) => (
            <p key={line} className="font-read text-text-2">
              {line}
            </p>
          ))}
          <p className="text-xs">
            <Link href={`${base}/email`} className="text-ochre-text font-semibold hover:underline">
              {mailOn
                ? "Bills by email settings"
                : "Have bills file themselves: set up Bills by email"}
            </Link>
          </p>
        </CardContent>
      </Card>

      {canEdit && (
        <details className="group flex flex-col">
          <summary className={cn(summaryButton, "list-none [&::-webkit-details-marker]:hidden")}>
            + Upload an invoice or statement
          </summary>
          <Card className="mt-3">
            <CardContent>
              <UploadBillForm slug={tenant.slug} supplierId={account.supplierId} />
            </CardContent>
          </Card>
        </details>
      )}

      {canEdit && (
        <details open={empty} className="group flex flex-col">
          <summary className={cn(summaryButton, "list-none [&::-webkit-details-marker]:hidden")}>
            + Add invoice or payment
          </summary>
          <Card className="mt-3">
            <CardContent className="flex flex-col gap-5">
              <EntryForm
                key={account.supplierId}
                slug={tenant.slug}
                supplierId={account.supplierId}
                today={today}
              />
              <div className="border-border border-t pt-4">
                <p className="text-muted-foreground mb-2 text-xs">
                  How long {name} gives you to pay an invoice. Due dates are worked out from this.
                </p>
                <TermsForm
                  slug={tenant.slug}
                  supplierId={account.supplierId}
                  days={account.termsDays}
                />
              </div>
            </CardContent>
          </Card>
        </details>
      )}

      <Panel
        title="Ledger"
        aside={
          <span className="text-muted-foreground text-xs">
            {account.ledger.length} entr{account.ledger.length === 1 ? "y" : "ies"}, newest first
          </span>
        }
      >
        {empty ? (
          <p className="text-muted-foreground text-sm">No entries yet.</p>
        ) : (
          <LedgerTable
            rows={account.ledger}
            money={money}
            base={base}
            running={running}
            remove={canEdit ? { slug: tenant.slug } : undefined}
          />
        )}
        <p className="text-muted-foreground text-xs">
          How this works: {name}&apos;s most recent statement is taken as the true balance on its
          date. Invoices and payments dated after it are added and taken off to get today&apos;s
          figure, so an old slip can&apos;t linger: each new statement sets the whole account
          straight. A balance marked <strong>credit</strong> is in your favour.
          {history.rows.some((row) => row.counted && row.running === null) &&
            " No balance is shown before their first statement, because the starting figure isn't known."}
        </p>
      </Panel>

      {statements.length > 0 && (
        <Panel title="Statements · where the account was set straight">
          <ul className="divide-border flex flex-col divide-y text-sm">
            {statements.map((row) => {
              const delta = row.delta === null ? null : new Money(row.delta);
              return (
                <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2">
                  <span className="font-semibold whitespace-nowrap">{day(row.date, "full")}</span>
                  <span className="tabular-nums">
                    {name} said{" "}
                    <BalanceWords value={stated.get(row.id) ?? row.running ?? "0"} money={money} />
                  </span>
                  {row.current && <Badge tone="open">Today&apos;s balance starts here</Badge>}
                  <span className="text-muted-foreground font-read basis-full text-xs">
                    {delta === null
                      ? "Nothing was written down between this and the statement before, so there was nothing to check it against."
                      : delta.isZero()
                        ? "It matches what was written down up to then."
                        : `Your entries came to ${money(row.computedBefore ?? "0")}; their figure was ${money(row.delta ?? "0")} ${delta.gt(0) ? "higher" : "lower"}. The account carried on from their figure.`}
                  </span>
                </li>
              );
            })}
          </ul>
        </Panel>
      )}

      {payments.length > 0 && (
        <Panel title="Payments and credits · which bills each one cleared">
          <ul className="divide-border flex flex-col divide-y text-sm">
            {payments.map((p) => (
              <li key={p.id} className="flex flex-col gap-0.5 py-2">
                <span className="flex flex-wrap items-baseline gap-x-3">
                  <span className="font-semibold whitespace-nowrap">{day(p.date, "full")}</span>
                  <Badge tone={p.kind === "PAYMENT" ? "good" : "open"}>
                    {p.kind === "PAYMENT" ? "Payment" : "Credit"}
                  </Badge>
                  <span className="text-mint-ink font-semibold tabular-nums">
                    {money(p.amount)}
                  </span>
                  {p.reference && <span className="font-mono text-[13px]">{p.reference}</span>}
                </span>
                <span className="font-read text-text-2 text-xs">
                  {p.cleared.length === 0 ? (
                    "Not counted against an invoice written down here."
                  ) : (
                    <>
                      Cleared{" "}
                      {p.cleared.map((c, i) => (
                        <span key={c.invoiceId}>
                          {i > 0 && ", "}
                          <InvoiceLink base={base} id={c.invoiceId} reference={c.reference} />{" "}
                          {c.whole ? "in full" : `(${money(c.amount)} of it)`}
                        </span>
                      ))}
                      .
                    </>
                  )}
                  {new Money(p.rest).gt(0) &&
                    ` ${money(p.rest)} went against what was owed before these invoices, or is in credit.`}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">
            Worked out oldest bill first, the way a running account is paid. Nothing here is stored:
            add or correct an entry and it is worked out again.
          </p>
        </Panel>
      )}
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
