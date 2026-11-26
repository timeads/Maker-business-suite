import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  accountsSummary,
  choiceOf,
  mergeAccounts,
  readAccountRows,
  yearBefore,
} from "@/lib/dashboard/expense-accounts";
import {
  EXPENSES_KEY,
  EXPENSES_MODULE,
  RULE_WORDS,
  actionWords,
  parseExpenseSorting,
} from "@/lib/dashboard/expenses";
import { formatMoney } from "@/lib/dashboard/format";
import { localDate } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { AccountSortingForm, ExpenseSortingForm } from "../../../dashboard/money-settings-forms";

export const metadata: Metadata = { title: "Sorting expenses" };

/** How many recent expenses the payee and account suggestions are drawn from. */
const SEEN = 1000;

/** The most common names, most used first. */
function commonest(values: (string | null)[], limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value && value.trim()) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

/**
 * Settings → Money → Sorting expenses. First and mainly: one choice per
 * account in the books, which sorts every expense in it. Then payee defaults
 * and rules, for the exceptions. The whole team can look; owners and admins
 * change it.
 */
export default async function ExpenseSortingSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/expenses`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;
  const today = localDate(new Date(), tenant.timezone);
  const day = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;

  const supabase = await createClient();
  const [revenue, config, seen, listed] = await Promise.all([
    loadRevenueSettings(supabase, tenant.id),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", EXPENSES_MODULE)
      .eq("key", EXPENSES_KEY)
      .maybeSingle(),
    supabase
      .from("book_expenses")
      .select("payee, account")
      .eq("tenant_id", tenant.id)
      .eq("is_move", false)
      .is("removed_at", null)
      .order("txn_date", { ascending: false })
      .limit(SEEN),
    supabase.rpc("money_expense_accounts", { p_tenant_id: tenant.id, p_since: yearBefore(day) }),
  ]);
  if (listed.error) throw new Error(`Could not load the accounts: ${listed.error.message}`);
  const settings = parseExpenseSorting(config.data?.body);
  const rows = (seen.data ?? []) as { payee: string | null; account: string | null }[];
  const accounts = mergeAccounts(
    readAccountRows((listed.data as Record<string, unknown>[] | null) ?? []),
  );
  const summary = accountsSummary(
    settings,
    accounts.filter((a) => a.name !== null),
  );
  const lineName = (id: string) =>
    revenue.lines.find((line) => line.id === id)?.name ?? "a removed line";
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/expenses`, label: "Expenses to sort" }}
        title="Sorting expenses"
        description="Your books already put every expense in an account. Choose once per account and Money sorts every expense in it, past and future. Your own choice on one expense always wins."
      />

      <Card id="by-account">
        <CardHeader>
          <CardTitle>By account</CardTitle>
          <CardDescription>
            An account you haven&apos;t chosen for yet counts as shared: it&apos;s in your totals,
            budget and cash health just as your books have it, shared across your lines in profit by
            line, and it never waits in the inbox. Pick &ldquo;Decide each one&rdquo; for an account
            you&apos;d rather go through by hand.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {accounts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No expenses from your books yet. Once QuickBooks is connected, its accounts show up
              here after the next sync.
            </p>
          ) : (
            <>
              <p className="bg-muted rounded-md px-3 py-2 text-sm" role="status">
                {summary.automatic === 0
                  ? `Every one of your ${summary.accounts} accounts has a choice.`
                  : `${summary.automatic} of your ${summary.accounts} ${summary.accounts === 1 ? "account is" : "accounts are"} still on the automatic default (shared).`}
                {summary.waiting > 0
                  ? ` ${summary.waiting.toLocaleString("en-US")} ${summary.waiting === 1 ? "expense is" : "expenses are"} waiting in the inbox.`
                  : " Nothing is waiting in the inbox."}
              </p>
              {revenue.lines.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  Set up your business lines first, so there&apos;s somewhere to put each account.{" "}
                  <Link
                    href={`${base}/settings/money/lines`}
                    className="underline underline-offset-4"
                  >
                    Revenue and business lines
                  </Link>
                </p>
              ) : canEdit ? (
                <AccountSortingForm
                  slug={tenant.slug}
                  settings={settings}
                  lines={revenue.lines}
                  accounts={accounts}
                  currency={tenant.currency}
                />
              ) : (
                <ul className="flex flex-col gap-1 text-sm">
                  {accounts
                    .filter((a) => a.name !== null)
                    .map((a) => {
                      const choice = choiceOf(settings, a);
                      return (
                        <li key={`${a.ref}-${a.name}`} className="flex flex-wrap gap-2">
                          <span className="font-medium">{a.name}</span>
                          <span className="text-muted-foreground">
                            {money(a.recentCents)} in the last 12 months →
                          </span>
                          {choice ? (
                            <span>
                              {choice.action.sort === "each"
                                ? "Decided one by one"
                                : actionWords(choice.action, lineName)}
                            </span>
                          ) : (
                            <Badge tone="closed">Shared (automatic)</Badge>
                          )}
                        </li>
                      );
                    })}
                </ul>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Exceptions: payee defaults and rules</CardTitle>
          <CardDescription>
            These speak before the account, for the times one payee or one kind of charge belongs
            somewhere else. One that a rule only suggests waits in the inbox with the suggestion
            beside it. Nothing here ever changes an expense someone sorted by hand, or one put back
            in the inbox.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {revenue.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Set up your business lines first.{" "}
              <Link href={`${base}/settings/money/lines`} className="underline underline-offset-4">
                Revenue and business lines
              </Link>
            </p>
          ) : canEdit ? (
            <ExpenseSortingForm
              slug={tenant.slug}
              settings={settings}
              lines={revenue.lines}
              payees={commonest(
                rows.map((row) => row.payee),
                200,
              )}
              accounts={commonest(
                rows.map((row) => row.account),
                200,
              )}
            />
          ) : settings.vendors.length === 0 && settings.rules.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No payee defaults or rules yet. An owner or admin can add them here.
            </p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <ul className="flex flex-col gap-1">
                {settings.vendors.map((v) => (
                  <li key={v.id}>
                    Everything from {v.payee} → {actionWords(v.action, lineName)}
                    {v.fill_in ? "" : " (suggested only)"}
                  </li>
                ))}
              </ul>
              <ol className="list-decimal pl-5">
                {settings.rules.map((r) => (
                  <li key={r.id}>
                    {RULE_WORDS[r.field].label} “{r.words}” → {actionWords(r.action, lineName)}
                    {r.fill_in ? "" : " (suggested only)"}
                    {r.firm ? ", before payee defaults" : ""}
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground">An owner or admin can change these.</p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
