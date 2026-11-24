import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { mailNotices, type MailNotice } from "@/lib/stock/mail/notices";
import { documentsSummary, readCountsWords } from "@/lib/stock/mail/words";
import type { LedgerRow, SupplierAccount } from "./data";
import { lookFacts, recentSkipped, type MailFacts } from "./mail-data";
import { AssignPendingForm, ReadNowButton, SettleButton } from "./mail-forms";
import { InvoiceLink, Note, day, moment, type MoneyText } from "./parts";
import { RemoveEntryButton } from "./forms";

/** The notices about reading email that apply now, for these accounts. */
export function mailNoticesFor(
  facts: MailFacts,
  accounts: SupplierAccount[],
  today: string,
  hiddenKeys: readonly string[],
): MailNotice[] {
  const { lastGood, lastFailed } = lookFacts(facts.reads);
  const byId = new Map(accounts.map((a) => [a.supplierId, a]));
  const quiet = facts.sources.bank
    .flatMap((b) => b.payees)
    .filter((p) => p.quiet_days !== null && byId.has(p.supplier_id))
    .map((p) => {
      const account = byId.get(p.supplier_id)!;
      const dates = account.ledger.map((row) => row.date).sort();
      const payments = account.ledger
        .filter((row) => row.type === "PAYMENT")
        .map((row) => row.date)
        .sort();
      return {
        supplierId: p.supplier_id,
        quietDays: p.quiet_days!,
        lastPayment: payments.at(-1) ?? null,
        firstEntry: dates[0] ?? null,
        owes: Number(account.balance.estimatedBalance) > 0,
      };
    });
  return mailNotices(
    {
      on: facts.readingOn,
      since: facts.sourcesSavedAt,
      lastGoodAt: lastGood?.at ?? null,
      lastFailed,
      now: new Date(),
      today,
      quiet,
    },
    hiddenKeys,
  );
}

/** "The automatic read isn't running" and "payments have stopped arriving". */
export function MailNotices({
  notices,
  names,
  slug,
  base,
  timezone,
  canEdit,
}: {
  notices: MailNotice[];
  names: Map<string, string>;
  slug: string;
  base: string;
  timezone: string;
  canEdit: boolean;
}) {
  return (
    <>
      {notices
        .filter((n) => !n.hidden)
        .map((n) =>
          n.kind === "mail-stopped" ? (
            <Note
              key={n.key}
              tone="bad"
              title="The automatic read of your Gmail isn't running"
              hide={canEdit ? { slug, noticeKey: n.key } : undefined}
            >
              <p>
                {n.error
                  ? `The last read didn't finish: ${n.error} `
                  : n.lastAt
                    ? `It last read your mail on ${moment(n.lastAt, timezone)}. `
                    : "It hasn't read your mail yet. "}
                New invoices, statements and payment notices won&apos;t reach these balances until
                it runs again.{" "}
                <Link href={`${base}/email`} className="font-semibold underline">
                  Check the setup
                </Link>
                , or forward bills to your bills address instead.
              </p>
            </Note>
          ) : (
            <Note
              key={n.key}
              title={`Payments to ${names.get(n.supplierId) ?? "a supplier"} have stopped arriving`}
              hide={canEdit ? { slug, noticeKey: n.key } : undefined}
            >
              <p>
                You still owe them, and{" "}
                {n.lastPayment
                  ? `the last payment on the account is from ${day(n.lastPayment, "full")}, ${n.days} days ago`
                  : `no payment has been written down in ${n.days} days`}
                . If you&apos;ve paid since, the notice may not have reached us: add the payment by
                hand, or check the bank&apos;s sender under{" "}
                <Link href={`${base}/email`} className="font-semibold underline">
                  Bills by email
                </Link>
                .
              </p>
            </Note>
          ),
        )}
    </>
  );
}

/** Entries waiting for a look: each with why, where it came from, and what to do. */
export function ToCheckList({
  rows,
  slug,
  base,
  money,
  canEdit,
  showSupplier = true,
}: {
  rows: LedgerRow[];
  slug: string;
  base: string;
  money: MoneyText;
  canEdit: boolean;
  showSupplier?: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <ul className="divide-border flex flex-col divide-y">
      {rows.map((row) => {
        const what =
          row.type === "INVOICE"
            ? `invoice ${row.reference ?? ""}`.trim()
            : row.type === "STATEMENT"
              ? `statement of ${day(row.date)}`
              : `payment of ${day(row.date)}`;
        return (
          <li
            key={row.id}
            className="flex flex-wrap items-start justify-between gap-3 py-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <Badge tone="waiting">To check</Badge>
                {showSupplier && (
                  <Link
                    href={`${base}/${row.supplierId}`}
                    className="font-semibold hover:underline"
                  >
                    {row.supplierName}
                  </Link>
                )}
                {row.type === "INVOICE" ? (
                  <InvoiceLink base={base} id={row.id} reference={row.reference} />
                ) : (
                  <span>{row.type === "STATEMENT" ? "Statement" : "Payment"}</span>
                )}
                <span className="tabular-nums">
                  {money(row.type === "STATEMENT" ? (row.statedBalance ?? "0") : row.amount)}
                </span>
                <span className="text-muted-foreground">{day(row.date, "full")}</span>
              </p>
              <p className="font-read text-text-2 mt-0.5">
                {row.reviewNote ?? "Have a look at this one."}
              </p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {row.gmailLink ? (
                  <a
                    href={row.gmailLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-ochre-text font-semibold hover:underline"
                  >
                    Open the email in Gmail
                  </a>
                ) : row.forwarded ? (
                  "Forwarded to your bills address"
                ) : row.source === "upload" ? (
                  "From an uploaded file"
                ) : (
                  "On the account"
                )}
                {row.type === "INVOICE" && " · open the invoice to correct its date or amount"}
                {" · it counts in the balance meanwhile"}
              </p>
            </div>
            {canEdit && (
              <div className="flex flex-none items-start gap-2">
                <SettleButton slug={slug} entryId={row.id} what={what} />
                <RemoveEntryButton slug={slug} entryId={row.id} what={`the ${what}`} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One line: when Gmail was last read and what came in. */
export function lastReadWords(facts: MailFacts, timezone: string): string | null {
  const { lastGood, underway } = lookFacts(facts.reads);
  if (underway) return "Reading your Gmail now…";
  if (lastGood) {
    return `Last automatic read ${moment(lastGood.at, timezone)} · ${readCountsWords(lastGood.counts)}`;
  }
  return facts.readingOn ? "No automatic read yet" : null;
}

/**
 * What has come in by email across every supplier: when it was last read,
 * what is waiting for a person, and what was left out and why.
 */
export function MailPanel({
  facts,
  accounts,
  notices,
  slug,
  base,
  money,
  timezone,
  canEdit,
}: {
  facts: MailFacts;
  accounts: SupplierAccount[];
  notices: MailNotice[];
  slug: string;
  base: string;
  money: MoneyText;
  timezone: string;
  canEdit: boolean;
}) {
  const toCheck = accounts.flatMap((a) => a.ledger.filter((row) => row.needsReview));
  const skipped = recentSkipped(facts.reads);
  const anyOn = facts.readingOn || facts.bills !== null;
  const suppliers = accounts
    .filter((a) => !a.archived)
    .map((a) => ({ id: a.supplierId, name: a.name }));
  const names = new Map(accounts.map((a) => [a.supplierId, a.name]));
  const read = lastReadWords(facts, timezone);
  const forwarded =
    facts.bills?.lastReceivedAt &&
    `Last forwarded message ${moment(facts.bills.lastReceivedAt, timezone)}`;

  if (!anyOn && toCheck.length === 0 && facts.pending.length === 0) {
    if (!facts.forwardingOffered && !facts.gmailOffered) return null;
    return (
      <p className="text-muted-foreground text-xs print:hidden">
        Tired of typing bills in?{" "}
        <Link href={`${base}/email`} className="text-ochre-text font-semibold hover:underline">
          Set up Bills by email
        </Link>{" "}
        and invoices, statements and payment notices file themselves.
      </p>
    );
  }

  return (
    <section className="flex flex-col gap-2 print:hidden">
      <MailNotices
        notices={notices}
        names={names}
        slug={slug}
        base={base}
        timezone={timezone}
        canEdit={canEdit}
      />
      <Card>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div>
              <h2 className="text-[15.5px] leading-snug font-bold tracking-[-0.01em]">
                Bills by email
              </h2>
              <p className="text-muted-foreground text-xs">
                {[read, forwarded].filter(Boolean).join(" · ") || "Nothing has come in yet"}
                {" · "}
                <Link
                  href={`${base}/email`}
                  className="text-ochre-text font-semibold hover:underline"
                >
                  Settings
                </Link>
              </p>
            </div>
            {canEdit && facts.readingOn && <ReadNowButton slug={slug} />}
          </div>

          {facts.bills?.confirm && (
            <p className="text-ochre-text text-sm">
              Gmail wants to confirm your bills address.{" "}
              <Link href={`${base}/email`} className="font-semibold underline">
                See the code
              </Link>
            </p>
          )}

          {facts.pending.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">
                Whose {facts.pending.length === 1 ? "is this" : "are these"}?
              </h3>
              <p className="text-muted-foreground text-xs">
                Forwarded mail we couldn&apos;t match to a supplier. Nothing from it is on any
                account until you say whose it is.
              </p>
              <ul className="divide-border mt-1 flex flex-col divide-y">
                {facts.pending.map((p) => (
                  <li key={p.id} className="flex flex-col gap-1.5 py-2 text-sm">
                    <p>
                      <span className="font-read">{p.subject || "(no subject)"}</span>{" "}
                      <span className="text-muted-foreground">
                        · from {p.sender || "an unknown sender"} · {day(p.sentDay, "full")}
                      </span>
                    </p>
                    <p className="font-read text-text-2">{documentsSummary(p.documents)}</p>
                    {canEdit && (
                      <AssignPendingForm slug={slug} pendingId={p.id} suppliers={suppliers} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {toCheck.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold">{toCheck.length} to check</h3>
              <ToCheckList rows={toCheck} slug={slug} base={base} money={money} canEdit={canEdit} />
            </div>
          )}

          {skipped.length > 0 && (
            <details className="text-sm">
              <summary className="text-muted-foreground cursor-pointer text-xs">
                Left out of recent reads ({skipped.length})
              </summary>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                {skipped.map((s, i) => (
                  <li key={`${s.what}-${i}`}>
                    <span className="font-read text-text-2">{s.what}</span>
                    <span className="text-muted-foreground">
                      : {s.reason} ({moment(s.at, timezone)})
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>
    </section>
  );
}
