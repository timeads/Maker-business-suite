import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadDebtView } from "@/lib/dashboard/debt/data";
import { usualPayment, type Debt } from "@/lib/dashboard/debt/figures";
import {
  DEBT_KIND_WORDS,
  DEBT_STATUS_WORDS,
  PLAN_KIND_WORDS,
  bpWords,
  type DebtKind,
} from "@/lib/dashboard/debt/settings";
import { formatMoney } from "@/lib/dashboard/format";
import { localDate, periodLabel } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { BalanceForm, DebtForm, RowButton, type DebtFormValues } from "../../debt-forms";

export const metadata: Metadata = { title: "Debts" };

const STATUS_TONE: Record<Debt["status"], BadgeTone> = {
  active: "open",
  paused: "waiting",
  closed: "closed",
};

const amountText = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));
const percentText = (bp: number | null) => (bp === null ? "" : bpWords(bp).replace(/%$/, ""));

const formValues = (d: Debt | null): DebtFormValues => ({
  id: d?.id ?? null,
  name: d?.name ?? "",
  kind: d?.kind ?? "card",
  plan: d?.plan ?? "pool",
  status: d?.status ?? "active",
  rate: d ? percentText(d.rateBp) : "",
  minimum: d ? amountText(d.minimum) : "",
  payment: amountText(d?.payment ?? null),
  revolving: percentText(d?.revolvingBp ?? null),
  due_day: d?.dueDay ? String(d.dueDay) : "",
  priority: d?.priority ? String(d.priority) : "",
  opening: amountText(d?.opening ?? null),
  books_account: d?.booksAccount ?? "",
  note: d?.note ?? "",
  balance: "",
});

/**
 * Money → Debts: each card, loan and line of credit, typed in by hand, with
 * its balances (given by a person or read from the books) and the payments
 * the books show into it. Owners and admins only.
 */
export default async function DebtsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/debts/accounts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [view, history, moves] = await Promise.all([
    loadDebtView(supabase, tenant),
    supabase
      .from("money_debt_balances")
      .select("id, debt_id, as_of, balance_cents, source")
      .eq("tenant_id", tenant.id)
      .order("as_of", { ascending: false })
      .order("noted_at", { ascending: false })
      .limit(600),
    supabase.rpc("money_move_accounts", { p_tenant_id: tenant.id }),
  ]);
  if (history.error) throw new Error(`Could not load the balances: ${history.error.message}`);
  const balances = (history.data ?? []) as {
    id: string;
    debt_id: string;
    as_of: string;
    balance_cents: number;
    source: "person" | "books";
  }[];
  const accounts = [
    ...new Set(((moves.data ?? []) as { account: string }[]).map((row) => row.account)),
  ];
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const day = (iso: string) => periodLabel(iso, "day", true);
  const local = localDate(new Date(), tenant.timezone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;

  return (
    <>
      <PageHeader
        title="Debts"
        description="Each card, loan and line of credit you're paying down. Only owners and admins can see these."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/dashboard/debts`}>Payoff plan</Link>
        </Button>
      </PageHeader>

      {view.debts.length > 0 && (
        <Card>
          <CardContent className="overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <caption className="sr-only">Your debts</caption>
              <thead className="text-muted-foreground text-xs">
                <tr className="border-border border-b">
                  {[
                    "Place",
                    "Debt",
                    "How it's paid",
                    "Owed",
                    "Started at",
                    "Rate",
                    "A month",
                    "Status",
                    "Paid off",
                  ].map((h, i) => (
                    <th
                      key={h}
                      scope="col"
                      className={`py-2 font-medium ${i >= 3 && i <= 6 ? "px-2 text-right" : "px-2"}`}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.debts.map((d) => {
                  const payoff = view.payoffs.get(d.id);
                  return (
                    <tr key={d.id} className="border-border border-b last:border-0">
                      <td className="px-2 py-2 tabular-nums">{d.priority ?? "–"}</td>
                      <th scope="row" className="px-2 py-2 font-normal">
                        <a href={`#debt-${d.id}`} className="font-medium hover:underline">
                          {d.name}
                        </a>
                        <span className="text-muted-foreground block text-xs">
                          {DEBT_KIND_WORDS[d.kind as DebtKind] ?? d.kind}
                          {d.dueDay ? ` · due on the ${d.dueDay}` : ""}
                        </span>
                      </th>
                      <td className="px-2 py-2">{PLAN_KIND_WORDS[d.plan]}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {d.balance === null ? "Not given" : money(d.balance)}
                        {d.balanceAsOf && (
                          <span className="text-muted-foreground block text-xs">
                            {d.balanceFrom === "books" ? "From your books" : "You gave it"},{" "}
                            {day(d.balanceAsOf)}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {d.opening === null ? "–" : money(d.opening)}
                      </td>
                      <td className="px-2 py-2 text-right tabular-nums">{bpWords(d.rateBp)}</td>
                      <td className="px-2 py-2 text-right tabular-nums">
                        {money(usualPayment(d))}
                      </td>
                      <td className="px-2 py-2">
                        <Badge tone={STATUS_TONE[d.status]}>{DEBT_STATUS_WORDS[d.status]}</Badge>
                      </td>
                      <td className="px-2 py-2">
                        {d.status !== "active"
                          ? "–"
                          : payoff
                            ? periodLabel(`${payoff}-01`, "month", true)
                            : (d.balance ?? 0) > 0
                              ? "Beyond five years"
                              : "Paid off"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {canEdit && (
        <Card>
          <details open={view.debts.length === 0}>
            <summary className="cursor-pointer px-6 py-4 font-semibold">Add a debt</summary>
            <CardContent>
              <DebtForm
                slug={tenant.slug}
                values={formValues(null)}
                currency={tenant.currency}
                accounts={accounts}
              />
            </CardContent>
          </details>
        </Card>
      )}

      {view.debts.map((d) => {
        const mine = balances.filter((b) => b.debt_id === d.id).slice(0, 12);
        const paid = view.payments.filter((p) => p.debtId === d.id).slice(0, 8);
        return (
          <Card key={d.id} id={`debt-${d.id}`}>
            <CardHeader>
              <CardTitle className="text-base">{d.name}</CardTitle>
              <CardDescription>
                {d.booksAccount
                  ? `Linked to “${d.booksAccount}” in your books: its balance and the payments into it come from there.`
                  : "Not linked to your books: give its balance by hand."}
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-6 lg:grid-cols-2">
              <div className="flex flex-col gap-3">
                <h3 className="text-sm font-semibold">Balances</h3>
                {canEdit && (
                  <BalanceForm
                    slug={tenant.slug}
                    debtId={d.id}
                    name={d.name}
                    today={today}
                    currency={tenant.currency}
                  />
                )}
                {mine.length === 0 ? (
                  <p className="text-muted-foreground text-sm">No balance yet.</p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {mine.map((b) => (
                      <li key={b.id} className="flex flex-wrap items-center justify-between gap-2">
                        <span>
                          {day(b.as_of)}{" "}
                          <span className="text-muted-foreground">
                            {b.source === "books" ? "· from your books" : "· you gave it"}
                          </span>
                        </span>
                        <span className="flex items-center gap-1 tabular-nums">
                          {money(Number(b.balance_cents))}
                          {canEdit && b.source === "person" && (
                            <RowButton
                              slug={tenant.slug}
                              what="balance"
                              id={b.id}
                              label="Take back"
                            />
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <h3 className="mt-2 text-sm font-semibold">Payments from your books</h3>
                {paid.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {d.booksAccount
                      ? "None in the books yet."
                      : "Link it to its account to see these."}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1 text-sm">
                    {paid.map((p, i) => (
                      <li key={`${p.date}-${i}`} className="flex justify-between gap-2">
                        <span>
                          {day(p.date)}
                          {p.fromAccount && (
                            <span className="text-muted-foreground"> from {p.fromAccount}</span>
                          )}
                        </span>
                        <span className="tabular-nums">{money(p.cents)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              {canEdit && (
                <details>
                  <summary className="cursor-pointer text-sm font-semibold">
                    Change the details
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    <DebtForm
                      slug={tenant.slug}
                      values={formValues(d)}
                      currency={tenant.currency}
                      accounts={accounts}
                    />
                    <p className="text-muted-foreground text-xs">
                      Paid off? Set it to Closed to keep its history. Remove it only if it was added
                      by mistake.
                    </p>
                    <RowButton
                      slug={tenant.slug}
                      what="debt"
                      id={d.id}
                      label="Remove this debt"
                      confirm={`Remove ${d.name} and its balances? This can't be undone.`}
                    />
                  </div>
                </details>
              )}
            </CardContent>
          </Card>
        );
      })}
    </>
  );
}
