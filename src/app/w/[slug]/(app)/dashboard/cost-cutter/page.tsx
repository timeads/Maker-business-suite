import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StatTile } from "@/components/charts/stat-tile";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadCutterSettings } from "@/lib/dashboard/data";
import { formatMoney, formatPercent } from "@/lib/dashboard/format";
import { averageCents, bookMonthOf, completeMonths } from "@/lib/dashboard/health";
import { localDate } from "@/lib/dashboard/range";
import {
  DECISION_WORDS,
  FLAG_WORDS,
  cutterSince,
  cutterSummary,
  findRecurring,
  type ChargeDecision as Decided,
  type Decision,
  type Flag,
  type SpendRow,
} from "@/lib/dashboard/recurring";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { ChargeDecision } from "../charge-decision";

export const metadata: Metadata = { title: "Cost cutter" };

/** Supabase hands back 1,000 rows at most; a year of expenses is read a page at a time. */
const PAGE = 1000;
const PAGES = 30;

const FLAG_TONE: Record<Flag, BadgeTone> = {
  growing: "bad",
  creeping: "waiting",
  new: "open",
  stopped: "closed",
  small: "waiting",
  overlap: "waiting",
};
const DECISION_TONE: Record<Decision, BadgeTone> = {
  keep: "good",
  review: "waiting",
  cancel: "bad",
  cancelled: "closed",
};

const day = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

/**
 * Money → Cost cutter: the charges that come round month after month, found
 * in the books' expenses, with what each costs a month and a year, and a
 * decision on each for the team. The whole team can look; owners and admins
 * decide. Nothing here cancels anything.
 */
export default async function CostCutterPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/cost-cutter`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const settings = await loadCutterSettings(supabase, tenant.id);
  const now = new Date();
  const local = localDate(now, tenant.timezone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const since = cutterSince(today, settings);

  const readSpend = async (): Promise<SpendRow[]> => {
    const rows: SpendRow[] = [];
    for (let page = 0; page < PAGES; page++) {
      const { data, error } = await supabase
        .from("book_expenses")
        .select("txn_date, amount_cents, payee, account, sort")
        .eq("tenant_id", tenant.id)
        .is("removed_at", null)
        .eq("is_move", false)
        .gt("amount_cents", 0)
        .gte("txn_date", since)
        .order("txn_date")
        .order("id")
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) throw new Error(`Could not load expenses: ${error.message}`);
      const batch = (data ?? []) as Record<string, unknown>[];
      for (const row of batch) {
        rows.push({
          txn_date: String(row.txn_date),
          amount_cents: Number(row.amount_cents),
          payee: (row.payee as string | null) ?? null,
          account: (row.account as string | null) ?? null,
          sort: (row.sort as string | null) ?? null,
        });
      }
      if (batch.length < PAGE) break;
    }
    return rows;
  };

  const [spend, decisions, books] = await Promise.all([
    readSpend(),
    supabase
      .from("money_charge_decisions")
      .select("charge_key, decision, note, payee, monthly_cents, decided_at")
      .eq("tenant_id", tenant.id)
      .limit(PAGE),
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "profit_and_loss")
      .order("period_start", { ascending: true })
      .limit(PAGE),
  ]);
  if (decisions.error) throw new Error(`Could not load decisions: ${decisions.error.message}`);
  if (books.error) throw new Error(`Could not load the books: ${books.error.message}`);

  const charges = findRecurring(spend, today, settings);
  const decided: (Decided & { payee: string | null; monthly_cents: number | null })[] = (
    (decisions.data ?? []) as Record<string, unknown>[]
  ).map((row) => ({
    key: String(row.charge_key),
    decision: row.decision as Decision,
    decided_at: String(row.decided_at),
    note: (row.note as string | null) ?? null,
    payee: (row.payee as string | null) ?? null,
    monthly_cents: row.monthly_cents === null ? null : Number(row.monthly_cents),
  }));
  const byKey = new Map(decided.map((d) => [d.key, d]));
  // The dashboard's revenue for the share: the last twelve complete months with revenue.
  const months = completeMonths(
    ((books.data ?? []) as { period_start: string; data: Record<string, unknown> }[]).map((row) =>
      bookMonthOf({ period_start: row.period_start, data: row.data ?? {} }),
    ),
    today.slice(0, 7),
  )
    .slice(-12)
    .map((m) => m.income)
    .filter((income) => income > 0);
  const averageRevenue = months.length > 0 ? averageCents(months) : null;
  const summary = cutterSummary(charges, decided, averageRevenue);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const found = new Set(charges.map((c) => c.key));
  const gone = decided.filter((d) => !found.has(d.key));

  return (
    <>
      <PageHeader
        title="Cost cutter"
        description="The bills that come round every month, found in your books, so you can decide what's worth keeping."
      >
        <Button asChild variant="outline" size="sm">
          <Link href={`${base}/settings/money/cost-cutter`}>Cost cutter settings</Link>
        </Button>
      </PageHeader>

      {spend.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing from your books yet</CardTitle>
            <CardDescription>
              Once QuickBooks is connected, the cost cutter looks through what you&apos;ve spent for
              charges that repeat. Nothing is ever changed in your books.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardContent className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <StatTile
                label="Recurring a month"
                value={money(summary.monthly)}
                note={
                  summary.shareOfRevenue === null
                    ? `${summary.payees} ${summary.payees === 1 ? "payee" : "payees"}`
                    : `${formatPercent(summary.shareOfRevenue)} of your average revenue`
                }
              />
              <StatTile label="A year at this rate" value={money(summary.yearly)} />
              <StatTile
                label="Payees"
                value={summary.payees.toLocaleString("en-US")}
                note={`Charging in ${settings.min_months} or more of the last ${settings.months_back} months`}
              />
              <StatTile
                label="Marked to cancel"
                value={money(summary.savingsPlanned)}
                note={`A month, or ${money(summary.savingsPlanned * 12)} a year`}
              />
            </CardContent>
          </Card>

          {summary.stillBilling.length > 0 && (
            <p
              className="border-brick/25 bg-brick-soft text-brick rounded-lg border px-3 py-2 text-sm"
              role="status"
            >
              Still charging after you marked {summary.stillBilling.length === 1 ? "it" : "them"}{" "}
              cancelled:{" "}
              {summary.stillBilling
                .map((key) => charges.find((c) => c.key === key)?.payee ?? key)
                .join(", ")}
              . Worth checking with {summary.stillBilling.length === 1 ? "them" : "each one"}.
            </p>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recurring charges</CardTitle>
              <CardDescription>
                Biggest yearly cost first. A month&apos;s cost is what they charged over the months
                they charged in. Deciding here is a note for your team: cancelling is done with the
                company itself.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {charges.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No charge repeats in {settings.min_months} or more months yet.
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[48rem] text-left text-sm">
                    <caption className="sr-only">
                      Recurring charges and what to do about them
                    </caption>
                    <thead className="text-muted-foreground text-xs">
                      <tr className="border-border border-b">
                        <th scope="col" className="py-2 pr-3 font-medium">
                          Payee
                        </th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">
                          A month
                        </th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">
                          A year
                        </th>
                        <th scope="col" className="px-2 py-2 text-right font-medium">
                          Last 6 months
                        </th>
                        <th scope="col" className="px-2 py-2 font-medium">
                          Worth knowing
                        </th>
                        <th scope="col" className="py-2 pl-2 font-medium">
                          Decision
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {charges.map((charge) => {
                        const decision = byKey.get(charge.key);
                        return (
                          <tr
                            key={charge.key}
                            className="border-border border-b align-top last:border-0"
                          >
                            <th scope="row" className="py-2.5 pr-3 font-normal">
                              <span className="font-medium">{charge.payee}</span>
                              <span className="text-muted-foreground block text-xs">
                                {charge.accounts.length > 1
                                  ? `${charge.accounts.length} accounts`
                                  : charge.account || "No account"}{" "}
                                · {charge.monthsSeen} months · last {day(charge.lastSeen)}
                              </span>
                            </th>
                            <td className="px-2 py-2.5 text-right tabular-nums">
                              {money(charge.monthly)}
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums">
                              {money(charge.yearly)}
                            </td>
                            <td className="px-2 py-2.5 text-right tabular-nums">
                              {charge.trend === null
                                ? "–"
                                : `${charge.trend > 0 ? "+" : ""}${formatPercent(charge.trend)}`}
                            </td>
                            <td className="px-2 py-2.5">
                              <div className="flex flex-wrap gap-1">
                                {charge.flags.map((flag) => (
                                  <Badge key={flag} tone={FLAG_TONE[flag]}>
                                    {FLAG_WORDS[flag]}
                                  </Badge>
                                ))}
                              </div>
                            </td>
                            <td className="py-2.5 pl-2">
                              {canEdit ? (
                                <ChargeDecision
                                  slug={tenant.slug}
                                  chargeKey={charge.key}
                                  payee={charge.payee}
                                  monthlyCents={charge.monthly}
                                  decision={decision?.decision ?? null}
                                  note={decision?.note ?? ""}
                                />
                              ) : decision ? (
                                <div className="flex flex-col gap-1">
                                  <Badge tone={DECISION_TONE[decision.decision]}>
                                    {DECISION_WORDS[decision.decision]}
                                  </Badge>
                                  {decision.note && (
                                    <span className="text-muted-foreground text-xs">
                                      {decision.note}
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-xs">Not decided</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {gone.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Decided, and not charging any more</CardTitle>
                <CardDescription>
                  Charges you made a decision on that no longer come round often enough to be
                  listed.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <ul className="flex flex-col gap-2 text-sm">
                  {gone.map((d) => (
                    <li key={d.key} className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{d.payee ?? d.key}</span>
                      <Badge tone={DECISION_TONE[d.decision]}>{DECISION_WORDS[d.decision]}</Badge>
                      {d.monthly_cents !== null && (
                        <span className="text-muted-foreground">
                          was {money(d.monthly_cents)} a month
                        </span>
                      )}
                      {d.note && <span className="text-muted-foreground">· {d.note}</span>}
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </>
  );
}
