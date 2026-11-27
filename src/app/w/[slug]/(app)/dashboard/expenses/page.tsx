import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  accountsSummary,
  mergeAccounts,
  readAccountRows,
  yearBefore,
} from "@/lib/dashboard/expense-accounts";
import { EXPENSES_KEY, EXPENSES_MODULE, parseExpenseSorting } from "@/lib/dashboard/expenses";
import { formatMoney } from "@/lib/dashboard/format";
import { localDate } from "@/lib/dashboard/range";
import {
  INBOX_PAGE,
  INBOX_VIEWS,
  VIEW_NAMES,
  inboxHref,
  likePattern,
  monthBounds,
  monthName,
  parseInboxQuery,
} from "@/lib/dashboard/inbox";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { ExpenseInbox, type InboxRow } from "./expense-inbox";

export const metadata: Metadata = { title: "Expenses to sort" };

type MonthRow = { month: string; to_sort: number; to_sort_cents: number; all_count: number };

/**
 * Money → Expenses to sort: what the books spent, waiting to be put on a
 * business line, split, shared or set aside. Everything about the view is in
 * the address. The whole team can look; owners and admins sort.
 */
export default async function ExpensesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/expenses`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const aiReady = Boolean(process.env.ANTHROPIC_API_KEY && process.env.SUPABASE_SECRET_KEY);
  const base = `/w/${tenant.slug}`;
  const here = `${base}/dashboard/expenses`;
  const query = parseInboxQuery(await searchParams);

  const supabase = await createClient();
  let list = supabase
    .from("book_expenses")
    .select(
      "id, kind, payment_type, txn_date, amount_cents, account, payee, memo, lines, sort, line_id, split, sorted_by, suggested",
      { count: "exact" },
    )
    .eq("tenant_id", tenant.id)
    .is("removed_at", null)
    .eq("is_move", false);
  if (query.view === "to_sort") list = list.is("sort", null);
  if (query.view === "sorted") list = list.not("sort", "is", null).neq("sort", "set_aside");
  if (query.view === "set_aside") list = list.eq("sort", "set_aside");
  if (query.month) {
    const { from, to } = monthBounds(query.month);
    list = list.gte("txn_date", from).lt("txn_date", to);
  }
  if (query.q) list = list.ilike("search_text", likePattern(query.q));
  const start = (query.page - 1) * INBOX_PAGE;

  const today = localDate(new Date(), tenant.timezone);
  const day = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
  const [revenue, months, sortingConfig, accountRows, rows] = await Promise.all([
    loadRevenueSettings(supabase, tenant.id),
    supabase.rpc("money_expense_months", { p_tenant_id: tenant.id }),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", EXPENSES_MODULE)
      .eq("key", EXPENSES_KEY)
      .maybeSingle(),
    supabase.rpc("money_expense_accounts", { p_tenant_id: tenant.id, p_since: yearBefore(day) }),
    list
      .order("txn_date", { ascending: false })
      .order("id")
      .range(start, start + INBOX_PAGE - 1),
  ]);
  if (rows.error) throw new Error(`Could not load expenses: ${rows.error.message}`);
  const monthRows = ((months.data as Record<string, unknown>[] | null) ?? []).map(
    (row): MonthRow => ({
      month: String(row.month),
      to_sort: Number(row.to_sort),
      to_sort_cents: Number(row.to_sort_cents),
      all_count: Number(row.all_count),
    }),
  );
  const total = rows.count ?? 0;
  const pages = Math.max(1, Math.ceil(total / INBOX_PAGE));
  const waiting = monthRows.reduce((sum, m) => sum + m.to_sort, 0);
  const inbox = (rows.data ?? []) as unknown as InboxRow[];
  // Allowed to fail: the inbox works without the account summary.
  const byAccount = accountRows.error
    ? null
    : accountsSummary(
        parseExpenseSorting(sortingConfig.data?.body),
        mergeAccounts(
          readAccountRows((accountRows.data as Record<string, unknown>[] | null) ?? []),
        ).filter((a) => a.name !== null),
      );

  return (
    <>
      <PageHeader
        title="Expenses to sort"
        description="Put each expense from your books on the line it belongs to, so Money can show what each part of your business really makes."
      >
        {monthRows.length > 0 && (
          <Button asChild variant="ghost" size="sm">
            <a href={inboxHref(`${here}/export`, query, { page: 1 })}>Download as a spreadsheet</a>
          </Button>
        )}
      </PageHeader>

      {monthRows.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing from your books yet</CardTitle>
            <CardDescription>
              Once QuickBooks is connected, its purchases, bills and journal entries show up here
              within a few hours, from the start of last year on. Nothing is ever changed in your
              books.
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
          {byAccount && byAccount.accounts > 0 && (
            <p className="bg-muted rounded-md px-3 py-2 text-sm" role="status">
              Expenses sort themselves by their account in your books. Only accounts you set to
              &ldquo;decide each one&rdquo; come here, with anything you put back.{" "}
              {byAccount.automatic > 0
                ? `${byAccount.automatic} of your ${byAccount.accounts} ${byAccount.accounts === 1 ? "account is" : "accounts are"} still on the automatic default (shared). `
                : ""}
              <Link
                href={`${base}/settings/money/expenses#by-account`}
                className="underline underline-offset-4"
              >
                Choose for each account
              </Link>
            </p>
          )}

          {revenue.lines.length === 0 && (
            <p className="bg-muted rounded-md px-3 py-2 text-sm" role="status">
              Set up your business lines first, then come back to sort expenses into them.{" "}
              <Link href={`${base}/settings/money/lines`} className="underline underline-offset-4">
                Set up your lines
              </Link>
            </p>
          )}

          <nav
            aria-label="Which expenses"
            className="bg-muted flex w-fit flex-wrap gap-1 rounded-lg p-1"
          >
            {INBOX_VIEWS.map((view) => (
              <Link
                key={view}
                href={inboxHref(here, query, { view })}
                aria-current={view === query.view ? "true" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors",
                  view === query.view
                    ? "bg-card font-medium shadow-xs"
                    : "text-muted-foreground hover:bg-card/60",
                )}
              >
                {VIEW_NAMES[view]}
                {view === "to_sort" && waiting > 0 && ` (${waiting.toLocaleString("en-US")})`}
              </Link>
            ))}
          </nav>

          <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
            <aside className="flex flex-col gap-2 lg:w-56 lg:shrink-0">
              <h2 className="text-sm font-semibold">Months</h2>
              <ul className="flex flex-wrap gap-1 lg:flex-col">
                <li>
                  <Link
                    href={inboxHref(here, query, { month: null })}
                    aria-current={query.month === null ? "true" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1 text-sm",
                      query.month === null ? "bg-card font-medium" : "hover:bg-card/60",
                    )}
                  >
                    Every month
                  </Link>
                </li>
                {monthRows.map((m) => (
                  <li key={m.month}>
                    <Link
                      href={inboxHref(here, query, { month: m.month })}
                      aria-current={query.month === m.month ? "true" : undefined}
                      className={cn(
                        "flex justify-between gap-3 rounded-md px-2 py-1 text-sm",
                        query.month === m.month ? "bg-card font-medium" : "hover:bg-card/60",
                      )}
                    >
                      <span>{monthName(m.month)}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {m.to_sort === 0 ? "all sorted" : `${m.to_sort} to sort`}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </aside>

            <section className="flex min-w-0 flex-1 flex-col gap-3">
              <form action={here} className="flex flex-wrap gap-2" role="search">
                {query.view !== "to_sort" && <input type="hidden" name="view" value={query.view} />}
                {query.month && <input type="hidden" name="month" value={query.month} />}
                <label htmlFor="expense-search" className="sr-only">
                  Search payees, accounts and memos
                </label>
                <input
                  id="expense-search"
                  name="q"
                  defaultValue={query.q}
                  placeholder="Search payees, accounts and memos"
                  className="border-input bg-card h-9 w-full rounded-sm border px-3 text-sm sm:w-80"
                />
                <Button type="submit" variant="outline">
                  Search
                </Button>
                {query.q && (
                  <Button asChild variant="ghost">
                    <Link href={inboxHref(here, query, { q: "" })}>Clear</Link>
                  </Button>
                )}
              </form>

              <p className="text-muted-foreground text-sm">
                {total === 0
                  ? query.view === "to_sort" && !query.q
                    ? "Nothing waiting here. Every expense is sorted."
                    : "No expenses match."
                  : `${total.toLocaleString("en-US")} ${total === 1 ? "expense" : "expenses"}${
                      query.month ? ` in ${monthName(query.month)}` : ""
                    }${
                      query.view === "to_sort" && query.month
                        ? `, ${formatMoney(
                            (monthRows.find((m) => m.month === query.month)?.to_sort_cents ?? 0) /
                              100,
                            tenant.currency,
                          )} in all`
                        : ""
                    }.`}
              </p>

              {inbox.length > 0 && (
                <ExpenseInbox
                  slug={tenant.slug}
                  rows={inbox}
                  lines={revenue.lines}
                  currency={tenant.currency}
                  canEdit={canEdit && revenue.lines.length > 0}
                  aiReady={aiReady}
                  rulesHref={`${base}/settings/money/expenses`}
                />
              )}

              {pages > 1 && (
                <nav aria-label="Pages" className="flex items-center gap-2 text-sm">
                  {query.page > 1 && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={inboxHref(here, query, { page: query.page - 1 })}>Newer</Link>
                    </Button>
                  )}
                  <span className="text-muted-foreground">
                    Page {query.page} of {pages}
                  </span>
                  {query.page < pages && (
                    <Button asChild variant="outline" size="sm">
                      <Link href={inboxHref(here, query, { page: query.page + 1 })}>Older</Link>
                    </Button>
                  )}
                </nav>
              )}

              <p className="text-muted-foreground text-xs">
                Read from QuickBooks every few hours, from the start of last year. Money moved
                between your own accounts (paying down a card or a loan) isn&apos;t an expense, so
                it never shows here. Account choices, payee defaults and rules live in{" "}
                <Link
                  href={`${base}/settings/money/expenses`}
                  className="underline underline-offset-4"
                >
                  Settings → Money → Sorting expenses
                </Link>
                .
              </p>
            </section>
          </div>
        </>
      )}
    </>
  );
}
