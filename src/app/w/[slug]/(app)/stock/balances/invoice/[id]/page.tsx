import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { localDay } from "@/lib/bookings/slots";
import { sourceLabel } from "@/lib/stock/balance/activity";
import {
  invoiceNeighbours,
  invoiceTimeline,
  type InvoiceEvent,
  type InvoiceStanding,
} from "@/lib/stock/balance/history";
import { Money } from "@/lib/stock/balance/money";
import { confirmedWords, dueWords, weekDay } from "@/lib/stock/balance/words";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { stockAccess } from "../../../gate";
import { loadBalances } from "../../data";
import { CorrectEntryForm, PaidTick, RemoveEntryButton } from "../../forms";
import {
  BalanceValue,
  InvoiceLink,
  ManagersOnly,
  Panel,
  day,
  days,
  label,
  moment,
  moneyText,
  type MoneyText,
} from "../../parts";

export const metadata: Metadata = { title: "Invoice" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function status(invoice: InvoiceStanding): { label: string; tone: BadgeTone }[] {
  if (invoice.notCounted === "future") return [{ label: "Dated ahead", tone: "closed" }];
  if (invoice.notCounted === "duplicate") return [{ label: "Written down twice", tone: "closed" }];
  if (invoice.state === "cleared") return [{ label: "Paid", tone: "good" }];
  const out: { label: string; tone: BadgeTone }[] = [
    invoice.state === "part"
      ? { label: "Part paid", tone: "waiting" }
      : { label: "Owed", tone: "waiting" },
  ];
  if (invoice.paymentSentAt) out.push({ label: "Marked paid", tone: "open" });
  else if (invoice.daysPastDue > 0) out.push({ label: "Past due", tone: "bad" });
  return out;
}

const EVENT_WORDS: Record<InvoiceEvent["kind"], string> = {
  invoiced: "Invoiced",
  marked: "Marked paid",
  payment: "Payment counted against it",
  credit: "Credit counted against it",
  payBy: "Pay by (the due date is a weekend)",
  due: "Due",
};

/**
 * One invoice: its amount and dates, how much of it is paid and by which
 * payments, the "Paid" tick with who made it, where it sits on the supplier's
 * account, and correcting or removing it. Everything is worked out on read
 * from the supplier's ledger; owners and admins only, like the ledger itself.
 */
export default async function InvoicePage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/balances/invoice/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const base = `/w/${tenant.slug}/stock/balances`;
  if (!canManage(role)) {
    return (
      <>
        <PageHeader back={{ href: base, label: "Supplier balances" }} title="Invoice" />
        <ManagersOnly />
      </>
    );
  }
  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  // Read as the member: only an owner or admin of this workspace gets a row back.
  const { data: entry } = await supabase
    .from("supplier_ledger")
    .select("id, supplier_id, type")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (!entry || entry.type !== "invoice") notFound();

  const [{ accounts, today }, paidBy, people] = await Promise.all([
    loadBalances(supabase, tenant, entry.supplier_id as string),
    // Who ticked "Paid": read apart from the ledger and allowed to fail, so
    // the balances still open on a database that doesn't keep it yet.
    supabase
      .from("supplier_ledger")
      .select("payment_sent_by")
      .eq("tenant_id", tenant.id)
      .eq("id", id)
      .maybeSingle()
      .then(
        ({ data }) => (data?.payment_sent_by as string | null | undefined) ?? null,
        () => null,
      ),
    supabase.rpc("chat_people", { p_tenant_id: tenant.id }).then(
      ({ data }) =>
        (Array.isArray(data) ? data : []) as {
          user_id: string;
          email: string | null;
          display_name: string | null;
        }[],
      () => [],
    ),
  ]);
  const account = accounts[0];
  const invoice = account?.history.invoices.find((i) => i.id === id);
  const row = account?.ledger.find((r) => r.id === id);
  if (!account || !invoice || !row) notFound();

  const money = moneyText(tenant.currency);
  const canEdit = entitlements.canWrite;
  const supplierHref = `${base}/${account.supplierId}`;
  const who = (userId: string | null) => {
    const person = userId ? people.find((p) => p.user_id === userId) : undefined;
    return person ? person.display_name?.trim() || person.email || null : null;
  };
  const waiting = account.paid.waiting.find((w) => w.billId === id);
  const confirmed = account.paid.confirmed.find((c) => c.billId === id);
  const markedDay = invoice.paymentSentAt
    ? localDay(new Date(invoice.paymentSentAt), tenant.timezone)
    : null;
  const events = invoiceTimeline(invoice, today, markedDay);
  const place = invoiceNeighbours(account.history.invoices, id);
  const after = account.history.rows.find((r) => r.id === id);
  const due = dueWords(invoice.daysPastDue);
  const open = new Money(invoice.open);
  const counted = invoice.notCounted === null;
  const correctable = Boolean(row.reference) && row.source !== "books";

  return (
    <>
      <PageHeader
        back={{ href: supplierHref, label: `${account.name} — account balance` }}
        title={
          <>
            Invoice <span className="font-mono">{invoice.reference ?? "with no number"}</span>
          </>
        }
        description={`From ${account.name}, invoiced ${day(invoice.date, "full")}.`}
      >
        {status(invoice).map((s) => (
          <Badge key={s.label} tone={s.tone}>
            {s.label}
          </Badge>
        ))}
      </PageHeader>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="flex flex-col gap-1">
            <p className={label}>Still owed</p>
            <p
              className={cn(
                "text-3xl leading-tight font-bold tabular-nums",
                open.isZero() && "text-muted-foreground",
              )}
            >
              {money(invoice.open)}
            </p>
            <p className="text-muted-foreground text-xs">
              of {money(invoice.amount)} invoiced
              {new Money(invoice.paid).gt(0) && ` · ${money(invoice.paid)} paid`}
            </p>
          </CardContent>
        </Card>
        <Card className="md:col-span-2">
          <CardContent>
            <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
              <Fact name="Invoiced">
                {day(invoice.date, "full")}
                <Small>{days(Math.max(0, invoice.ageDays))} ago</Small>
              </Fact>
              <Fact name="Due">
                {weekDay(invoice.dueDate)}
                {counted && invoice.state !== "cleared" && (
                  <Small
                    className={
                      due.tone === "late"
                        ? "text-brick font-semibold"
                        : due.tone === "today"
                          ? "text-ochre-text font-semibold"
                          : undefined
                    }
                  >
                    {due.text}
                  </Small>
                )}
              </Fact>
              <Fact name="Pay by">
                {weekDay(invoice.payBy)}
                <Small>
                  {invoice.payBy === invoice.dueDate
                    ? "the due date"
                    : "the Friday before: it's due on a weekend"}
                </Small>
              </Fact>
              <Fact name="Days to pay">
                {days(account.termsDays)}
                <Small>
                  <Link href={supplierHref} className="hover:underline">
                    {account.name}&apos;s terms
                  </Link>
                </Small>
              </Fact>
            </dl>
          </CardContent>
        </Card>
      </div>

      {invoice.notCounted && (
        <p className="border-border bg-panel font-read rounded-lg border px-3 py-2 text-sm">
          {invoice.notCounted === "future"
            ? "This invoice is dated after today, so it isn't in the balance yet. It will be counted from its date."
            : "The same invoice number and amount is written down twice on this account. Only the newest one is counted when working out which bills are open; remove the one that shouldn't be here."}
        </p>
      )}

      <Panel
        title="How much of it is paid"
        aside={
          <span className="text-text-2">
            {money(invoice.paid)} of {money(invoice.amount)}
          </span>
        }
      >
        {invoice.clearedBy.length > 0 && (
          <ul className="divide-border flex flex-col divide-y text-sm">
            {invoice.clearedBy.map((c) => (
              <li key={c.entryId} className="flex flex-wrap items-baseline gap-x-3 py-2">
                <Badge tone={c.kind === "PAYMENT" ? "good" : "open"}>
                  {c.kind === "PAYMENT" ? "Payment" : "Credit"}
                </Badge>
                <span className="whitespace-nowrap">{day(c.date, "full")}</span>
                {c.reference && <span className="font-mono text-[13px]">{c.reference}</span>}
                <span className="text-mint-ink ml-auto font-semibold tabular-nums">
                  {money(c.amount)}
                </span>
              </li>
            ))}
          </ul>
        )}
        {new Money(invoice.unmatched).gt(0) && (
          <p className="font-read text-text-2 text-sm">
            {money(invoice.unmatched)} of it is paid without a payment written down here to show for
            it
            {account.balance.anchor
              ? `: ${account.name}'s statement already counts it as paid.`
              : "."}
          </p>
        )}
        {counted && invoice.clearedBy.length === 0 && new Money(invoice.unmatched).isZero() && (
          <p className="text-muted-foreground text-sm">Nothing has been counted against it yet.</p>
        )}
        <p className="text-muted-foreground text-xs">
          Payments and credits count against {account.name}&apos;s oldest bills first, so a payment
          you meant for this invoice may show against an older one. Worked out from the account each
          time; nothing is stored.
        </p>
      </Panel>

      <Panel title="Marked paid">
        {invoice.state !== "cleared" && counted ? (
          <div className="flex flex-col gap-1.5">
            <PaidTick
              slug={tenant.slug}
              entryId={id}
              checked={Boolean(invoice.paymentSentAt)}
              label={`Mark ${invoice.reference ?? "this bill"} as paid`}
              disabled={!canEdit}
            />
            {invoice.paymentSentAt && markedDay ? (
              <p
                className={cn(
                  "text-sm",
                  !waiting || waiting.state === "waiting"
                    ? "text-mint-ink"
                    : "text-ochre-text font-semibold",
                )}
              >
                <MarkedBy when={moment(invoice.paymentSentAt, tenant.timezone)} by={who(paidBy)} />{" "}
                {waiting?.state === "short"
                  ? "A payment has been added since, but this bill still shows as owed. Check the amount: payments clear the oldest bills first."
                  : waiting?.state === "late"
                    ? "No payment has been added since."
                    : "Waiting for the payment to show up."}
              </p>
            ) : (
              <p className="text-muted-foreground text-sm">
                Not marked. Tick it once you&apos;ve sent the money.
              </p>
            )}
          </div>
        ) : invoice.paymentSentAt && markedDay ? (
          <p className="text-mint-ink text-sm">
            <MarkedBy when={moment(invoice.paymentSentAt, tenant.timezone)} by={who(paidBy)} />{" "}
            {confirmed
              ? `Confirmed: ${confirmedWords(confirmed, markedDay, money)}.`
              : "It's no longer owed."}
          </p>
        ) : (
          <p className="text-muted-foreground text-sm">
            {counted
              ? "It was never ticked, and it's no longer owed."
              : "It can be ticked once it counts."}
          </p>
        )}
        <p className="text-muted-foreground text-xs">
          The tick is a note that the money has gone. The bill stays owed until the payment itself
          is on the account.
        </p>
      </Panel>

      <Panel title="Timeline">
        <ol className="flex flex-col gap-2 text-sm">
          {events.map((event, i) => (
            <li key={`${event.kind}-${i}`} className="flex flex-wrap items-baseline gap-x-3">
              <span
                className={cn(
                  "w-28 flex-none whitespace-nowrap tabular-nums",
                  !event.happened && "text-muted-foreground",
                )}
              >
                {day(event.date, "full")}
              </span>
              <span className={event.happened ? "font-semibold" : "text-muted-foreground"}>
                {EVENT_WORDS[event.kind]}
                {event.kind === "marked" && who(paidBy) ? ` by ${who(paidBy)}` : ""}
              </span>
              {event.amount && <span className="tabular-nums">{money(event.amount)}</span>}
              {event.reference && event.kind !== "invoiced" && (
                <span className="font-mono text-[13px]">{event.reference}</span>
              )}
              {!event.happened && <span className="text-muted-foreground text-xs">to come</span>}
            </li>
          ))}
        </ol>
      </Panel>

      <Panel
        title={`Its place on ${account.name}'s account`}
        aside={
          <span className="text-muted-foreground text-xs">
            Invoice {place.position} of {place.total}, oldest first
          </span>
        }
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <Fact name="The invoice before">
            <Neighbour invoice={place.before} base={base} money={money} />
          </Fact>
          <Fact name="The invoice after">
            <Neighbour invoice={place.after} base={base} money={money} />
          </Fact>
          <Fact name="Balance after this invoice">
            {after?.running == null ? (
              <span className="text-muted-foreground">
                {counted ? "Not known: it is from before their first statement" : "Not counted yet"}
              </span>
            ) : (
              <BalanceValue value={after.running} money={money} />
            )}
          </Fact>
        </dl>
        <p className="text-xs">
          <Link href={supplierHref} className="text-ochre-text font-semibold hover:underline">
            See it in {account.name}&apos;s ledger
          </Link>
        </p>
      </Panel>

      <Panel title="About this entry">
        <dl className="grid gap-4 text-sm sm:grid-cols-3">
          <Fact name="Note">
            <span className="font-read">{row.description || "—"}</span>
          </Fact>
          <Fact name="How it got here">{sourceLabel(row.source)}</Fact>
          <Fact name="Written down">
            {moment(row.createdAt, tenant.timezone)}
            {who(row.createdBy) && <Small>by {who(row.createdBy)}</Small>}
          </Fact>
        </dl>
      </Panel>

      {canEdit && (
        <Panel title="Correct or remove">
          {correctable ? (
            <CorrectEntryForm
              key={`${row.date}-${row.amount}-${row.description}`}
              slug={tenant.slug}
              entryId={id}
              date={row.date}
              amount={row.amount}
              note={row.description}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              {row.source === "books"
                ? "This came from your books. Change it there and it follows here."
                : "This invoice has no number to correct it by. To change it, remove it and add it again."}
            </p>
          )}
          <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-3">
            <p className="text-muted-foreground text-xs">
              Removing it takes it off the account and changes the balance. The invoice number
              can&apos;t be edited: to change it, remove this and add it again.
            </p>
            <RemoveEntryButton
              slug={tenant.slug}
              entryId={id}
              what={`the invoice${row.reference ? ` ${row.reference}` : ""} of ${day(row.date)}`}
              afterHref={supplierHref}
            />
          </div>
        </Panel>
      )}
    </>
  );
}

function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground text-xs">{name}</dt>
      <dd className="mt-0.5 font-semibold">{children}</dd>
    </div>
  );
}

function Small({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <span className={cn("text-muted-foreground block text-xs font-normal", className)}>
      {children}
    </span>
  );
}

/** "Marked paid Nov 20, 2026, 3:04 PM ET by Dana." */
function MarkedBy({ when, by }: { when: string; by: string | null }) {
  return (
    <>
      Marked paid {when}
      {by ? ` by ${by}` : ""}.
    </>
  );
}

function Neighbour({
  invoice,
  base,
  money,
}: {
  invoice: InvoiceStanding | null;
  base: string;
  money: MoneyText;
}) {
  if (!invoice) return <span className="text-muted-foreground font-normal">None</span>;
  return (
    <>
      <InvoiceLink base={base} id={invoice.id} reference={invoice.reference} />
      <Small>
        {day(invoice.date, "full")} · {money(invoice.amount)}
        {invoice.state === "cleared" ? " · paid" : ` · ${money(invoice.open)} owed`}
      </Small>
    </>
  );
}
