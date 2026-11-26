import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { NotNowButton } from "@/components/setup/not-now-button";
import { SetupList } from "@/components/setup/setup-list";
import { SetupStepCard } from "@/components/setup/setup-step";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import { loadBooksState, loadDebtView } from "@/lib/dashboard/debt/data";
import { bankKey, pickedBanks } from "@/lib/dashboard/debt/figures";
import { ORDER_CHOICE, bpWords, orderOf } from "@/lib/dashboard/debt/settings";
import { orderExplained, profitExplained, revenueExplained } from "@/lib/dashboard/explain";
import { mergeAccounts, readAccountRows, yearBefore } from "@/lib/dashboard/expense-accounts";
import { EXPENSES_KEY, EXPENSES_MODULE, parseExpenseSorting } from "@/lib/dashboard/expenses";
import { DEBT_FIELDS } from "@/lib/dashboard/figure-fields";
import { formatMoney } from "@/lib/dashboard/format";
import { hasLines } from "@/lib/dashboard/lines";
import { localDate, periodLabel } from "@/lib/dashboard/range";
import { MONEY_STEPS, MONEY_TOOL, lineSuggestions, moneySetupItems } from "@/lib/dashboard/setup";
import { loadMoneySetupFacts } from "@/lib/dashboard/setup-data";
import { getEntitlements } from "@/lib/entitlements";
import { loadNotNow } from "@/lib/setup/data";
import { firstOpenStep, openByStep, sortItems } from "@/lib/setup/items";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import {
  BookChoiceButton,
  DebtImportForm,
  DebtPlanForm,
  EmergencyAccountPicker,
  ReadBooksButton,
} from "../debt-forms";
import { FigureSettingsForm } from "../money-figure-forms";
import { AccountSortingForm } from "../money-settings-forms";
import { DebtBasicsForm } from "./debt-basics-form";
import { LinePicker } from "./line-picker";
import { ReadShopButton } from "./read-shop";

export const metadata: Metadata = { title: "Set up" };

/** The biggest expense accounts offered in step 5; the rest stay shared. */
const TOP_ACCOUNTS = 10;

/**
 * Money → Set up: the checklist as steps, each a small form that writes
 * through the same checked functions and settings as everywhere else.
 * Progress is the facts (`moneySetupItems`), never stored; a person lands
 * on the first step with something open, and any step can be skipped.
 * Steps 3 and 4 are about debts and exist only for owners and admins.
 */
export default async function MoneySetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/setup`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const when = (iso: string | null) =>
    iso
      ? new Intl.DateTimeFormat("en-US", {
          timeZone: tenant.timezone,
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }).format(new Date(iso))
      : "not yet";

  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const now = new Date();
  const local = localDate(now, tenant.timezone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const yearAgo = new Date(now.getTime() - 365 * 86_400_000);

  const [facts, notNow, orders, expenses, first, last, sorting, accountRows, groups, debtView] =
    await Promise.all([
      loadMoneySetupFacts(supabase, tenant, { manager, revenue, deep: true, now }),
      manager ? loadNotNow(supabase, tenant.id, MONEY_TOOL) : Promise.resolve([]),
      supabase
        .from("orders")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id),
      supabase
        .from("book_expenses")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id)
        .eq("is_move", false)
        .is("removed_at", null),
      supabase
        .from("book_expenses")
        .select("txn_date")
        .eq("tenant_id", tenant.id)
        .is("removed_at", null)
        .order("txn_date", { ascending: true })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("book_expenses")
        .select("txn_date")
        .eq("tenant_id", tenant.id)
        .is("removed_at", null)
        .order("txn_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("configs")
        .select("body")
        .eq("tenant_id", tenant.id)
        .eq("module", EXPENSES_MODULE)
        .eq("key", EXPENSES_KEY)
        .maybeSingle(),
      supabase.rpc("money_expense_accounts", {
        p_tenant_id: tenant.id,
        p_since: yearBefore(today),
      }),
      hasLines(revenue)
        ? Promise.resolve([])
        : supabase
            .rpc("money_line_revenue", {
              p_tenant_id: tenant.id,
              p_from: yearAgo.toISOString(),
              p_to: now.toISOString(),
              p_grouping: "month",
              p_timezone: tenant.timezone,
              p_figure: revenue.figure,
              p_by_class_date: false,
              p_dated_only: false,
            })
            .range(0, 4999)
            .then(({ data }) => (data as Record<string, unknown>[] | null) ?? []),
      manager ? loadDebtView(supabase, tenant, now).catch(() => null) : Promise.resolve(null),
    ]);
  const books = debtView
    ? await loadBooksState(supabase, tenant.id, debtView.debts).catch(() => null)
    : null;

  const items = moneySetupItems(facts);
  const { open, resting } = sortItems(items, notNow);
  // What a person sees: debt items only ever exist for owners and admins.
  const steps = MONEY_STEPS.filter((s) => manager || !s.managersOnly);
  const current = firstOpenStep(steps, open);
  const byStep = openByStep(open);
  const stepProps = (id: string) => {
    const index = steps.findIndex((s) => s.id === id);
    return {
      id,
      number: index + 1,
      title: steps[index].title,
      open: byStep.get(id)?.length ?? 0,
      current: current === id,
      next: steps[index + 1]
        ? { id: steps[index + 1].id, title: steps[index + 1].title }
        : undefined,
    };
  };
  const stepItems = (id: string) => (
    <SetupList
      slug={tenant.slug}
      tool={MONEY_TOOL}
      items={byStep.get(id) ?? []}
      canSnooze={canEdit}
    />
  );
  const lineName = (id: string) =>
    revenue.lines.find((line) => line.id === id)?.name ?? "a removed line";

  // Step 2: lines from what the sales already carry, by what they brought in.
  const suggestions = lineSuggestions(
    groups.map((row) => ({
      order_tags: (row.order_tags as string[] | null) ?? null,
      product_type: (row.product_type as string | null) ?? null,
      workshop: row.workshop === true,
      revenue_cents: Number(row.revenue_cents ?? 0),
    })),
  ).map((s) => ({ ...s, amount: money(s.cents) }));

  // Step 5: the biggest accounts over the last year.
  const accounts = accountRows.error
    ? []
    : mergeAccounts(readAccountRows((accountRows.data as Record<string, unknown>[] | null) ?? []))
        .filter((a) => a.name !== null)
        .slice(0, TOP_ACCOUNTS);
  const expenseSorting = parseExpenseSorting(sorting.data?.body);

  // Step 3: the debts the plan pays, and the books' other liabilities.
  const debts = debtView?.debts.filter((d) => d.status !== "closed") ?? [];
  const amount = (c: number | null) => (c === null ? "" : (c / 100).toFixed(2));
  const passThrough = facts.debts?.passThrough ?? [];
  const plans = debts.filter((d) => d.consolidated);
  const candidates = (debtView?.debts ?? [])
    .filter((d) => !d.consolidated)
    .map((d) => ({
      id: d.id,
      name: d.name,
      detail: d.balance === null ? "No balance yet" : money(d.balance),
      takenBy: d.coveredBy ? (plans.find((p) => p.id === d.coveredBy)?.name ?? "a plan") : null,
    }));
  const planAccounts = (books?.accounts ?? []).map((a) => ({
    id: a.id,
    name: a.name,
    balance: a.balance < 0 ? `in credit, ${money(-a.balance)}` : money(a.balance),
  }));
  const newPlan = (name: string, accountId: string, covers: string[]) => ({
    id: null,
    name,
    status: "active",
    rate: "",
    payment: "",
    due_day: "",
    priority: "",
    opening: "",
    note: "",
    balance_from: accountId ? ("account" as const) : ("covered" as const),
    plan_account_id: accountId,
    covers,
  });

  return (
    <>
      <PageHeader
        title="Set up"
        description="A few steps that make Money's figures true to your business. Skip anything, come back any time: this page remembers nothing but what you've already set."
      />

      {!manager && (
        <Card>
          <CardContent className="pt-6 text-sm">
            An owner or admin sets these up. You can see where things stand, and everything here is
            also under Settings → Money.
          </CardContent>
        </Card>
      )}

      {/* 1. What we read */}
      <SetupStepCard
        {...stepProps("read")}
        description="Everything on Money comes from your books and your shop. Here's what we have from each."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            <strong>QuickBooks:</strong>{" "}
            {facts.books && facts.books.status !== "disconnected"
              ? `${(expenses.count ?? 0).toLocaleString("en-US")} expenses${
                  first.data && last.data
                    ? `, from ${periodLabel(String(first.data.txn_date), "day", true)} to ${periodLabel(String(last.data.txn_date), "day", true)}`
                    : ""
                }. Last read ${when(facts.books.lastSyncedAt)}.`
              : "not connected."}
          </li>
          <li>
            <strong>Your shop:</strong>{" "}
            {facts.shop && facts.shop.status !== "disconnected"
              ? `${(orders.count ?? 0).toLocaleString("en-US")} orders. Last read ${when(facts.shop.lastSyncedAt)}.`
              : "not connected."}
          </li>
        </ul>
        {canEdit && (
          <div className="flex flex-wrap gap-3">
            {facts.books?.status === "active" && <ReadBooksButton slug={tenant.slug} />}
            {facts.shop?.status === "active" && <ReadShopButton slug={tenant.slug} />}
          </div>
        )}
        {stepItems("read")}
      </SetupStepCard>

      {/* 2. Business lines */}
      <SetupStepCard
        {...stepProps("lines")}
        description="Your business lines are the parts of your business you want to see apart, like classes and the shop. Sales find their line by the tags and types they already carry."
      >
        {hasLines(revenue) ? (
          <>
            <p className="text-sm">
              Your lines: {revenue.lines.map((l) => l.name).join(", ")}.{" "}
              <Link
                href={`${base}/settings/money/lines#rules`}
                className="text-ochre-text underline-offset-2 hover:underline"
              >
                Change them
              </Link>
            </p>
            <HowWorkedOut lines={revenueExplained(revenue)} />
          </>
        ) : canEdit ? (
          <LinePicker slug={tenant.slug} suggestions={suggestions} />
        ) : (
          <p className="text-muted-foreground text-sm">No business lines yet.</p>
        )}
        {stepItems("lines")}
      </SetupStepCard>

      {/* 3. Debts: owners and admins only */}
      {manager && debtView && (
        <SetupStepCard
          {...stepProps("debts")}
          description="Your debts come from your books each time QuickBooks syncs. QuickBooks doesn't keep rates or usual payments, so add those here. Only owners and admins see this."
        >
          {debts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No debts from your books yet.{" "}
              <Link href={`${base}/dashboard/debts/accounts`} className="underline">
                Add one that isn&apos;t in your books
              </Link>
            </p>
          ) : (
            <ul className="flex flex-col">
              {debts.map((d) => (
                <li
                  key={d.id}
                  className="border-border flex flex-col gap-2 border-b py-3 first:pt-0 last:border-0"
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span>
                      <Link
                        href={`${base}/dashboard/debts/accounts#debt-${d.id}`}
                        className="font-medium hover:underline"
                      >
                        {d.name}
                      </Link>
                      <span className="text-muted-foreground block text-xs">
                        {d.consolidated
                          ? "A plan that pays other debts"
                          : d.source === "books"
                            ? "From your books"
                            : "Typed in"}
                        {d.balance !== null ? ` · ${money(d.balance)} owed` : ""}
                        {!d.needsRate ? ` · ${bpWords(d.rateBp)}` : ""}
                      </span>
                    </span>
                    {canEdit && d.source === "books" && d.bookAccountId && !d.consolidated && (
                      <BookChoiceButton
                        slug={tenant.slug}
                        accountId={d.bookAccountId}
                        choice="not_debt"
                        label="Not a debt"
                        variant="ghost"
                      />
                    )}
                  </div>
                  {canEdit && !d.consolidated && (
                    <DebtBasicsForm
                      slug={tenant.slug}
                      debtId={d.id}
                      name={d.name}
                      values={{
                        rate: d.needsRate ? "" : bpWords(d.rateBp).replace(/%$/, ""),
                        minimum: d.minimum ? amount(d.minimum) : "",
                        payment: amount(d.payment),
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}

          {books && books.others.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Also in your books ({books.others.length}): is any of these a debt?
              </summary>
              <ul className="mt-2 flex flex-col gap-2 text-sm">
                {books.others.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {o.name}
                      <span className="text-muted-foreground block text-xs">
                        {o.typeWords} ·{" "}
                        {o.balance < 0 ? `in credit, ${money(-o.balance)}` : money(o.balance)}
                      </span>
                    </span>
                    {canEdit && (
                      <BookChoiceButton
                        slug={tenant.slug}
                        accountId={o.id}
                        choice="debt"
                        label="Count this as a debt"
                      />
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div id="plan" className="flex scroll-mt-4 flex-col gap-3">
            <p className="text-sm font-medium">Does one company pay several of these for you?</p>
            <p className="text-muted-foreground font-read text-sm">
              If you pay one amount a month to a company that pays some of your cards or loans, make
              it a plan: it counts as one debt with its own payment, and the debts it pays are
              folded under it so nothing is counted twice.
            </p>
            {canEdit &&
              passThrough.map((p) => (
                <details key={p.id} open>
                  <summary className="cursor-pointer text-sm">
                    Money moves through {p.name} into {p.pays.map((d) => d.name).join(" and ")}
                  </summary>
                  <div className="mt-3">
                    <DebtPlanForm
                      slug={tenant.slug}
                      values={newPlan(
                        p.name,
                        p.id,
                        p.pays.map((d) => d.id),
                      )}
                      currency={tenant.currency}
                      candidates={candidates}
                      accounts={planAccounts}
                    />
                  </div>
                </details>
              ))}
            {canEdit && (
              <details>
                <summary className="cursor-pointer text-sm">Yes, make a plan</summary>
                <div className="mt-3">
                  <DebtPlanForm
                    slug={tenant.slug}
                    values={newPlan("", "", [])}
                    currency={tenant.currency}
                    candidates={candidates}
                    accounts={planAccounts}
                  />
                </div>
              </details>
            )}
          </div>

          {canEdit && (
            <details>
              <summary className="cursor-pointer text-sm">
                Bring details across from a spreadsheet
              </summary>
              <div className="mt-3">
                <DebtImportForm slug={tenant.slug} />
              </div>
            </details>
          )}
          {stepItems("debts")}
        </SetupStepCard>
      )}

      {/* 4. Emergency fund: owners and admins only */}
      {manager && debtView && (
        <SetupStepCard
          {...stepProps("fund")}
          description="Tick the bank account your emergency fund is kept in, and say how big you'd like it to be. The plan builds it up alongside paying down debt."
        >
          {debtView.banks.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No bank accounts on a balance sheet yet. They show up here once QuickBooks has synced.
            </p>
          ) : canEdit ? (
            <EmergencyAccountPicker
              slug={tenant.slug}
              banks={debtView.banks.map((bank) => ({
                key: bankKey(bank),
                id: bank.id ?? null,
                name: bank.name,
                balance: money(bank.cents),
              }))}
              picked={pickedBanks(debtView.settings, debtView.banks).map(bankKey)}
            />
          ) : null}
          {canEdit && (
            <FigureSettingsForm
              slug={tenant.slug}
              setting="debt"
              groups={DEBT_FIELDS.filter((g) => g.title === "Emergency fund")}
              body={{ ...debtView.settings, [ORDER_CHOICE]: orderOf(debtView.settings) }}
              currency={tenant.currency}
            />
          )}
          {stepItems("fund")}
        </SetupStepCard>
      )}

      {/* 5. Expenses */}
      <SetupStepCard
        {...stepProps("expenses")}
        description="Your books already put every expense in an account. Choose a line for an account once and every expense in it follows, past and future; an account you leave alone counts as shared, spread across your lines in profit by line."
      >
        {!hasLines(revenue) ? (
          <p className="text-muted-foreground text-sm">
            This matters once you have business lines (step 2). Until then every expense counts
            towards the one business.
          </p>
        ) : accounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No expenses from your books yet. They show up after QuickBooks syncs.
          </p>
        ) : canEdit ? (
          <>
            <p className="text-muted-foreground text-sm">
              Your {accounts.length} biggest accounts over the last year. The rest stay shared; you
              can sort them any time in{" "}
              <Link href={`${base}/settings/money/expenses#by-account`} className="underline">
                Settings
              </Link>
              .
            </p>
            <AccountSortingForm
              slug={tenant.slug}
              settings={expenseSorting}
              lines={revenue.lines}
              accounts={accounts}
              currency={tenant.currency}
            />
          </>
        ) : null}
        {hasLines(revenue) && (
          <HowWorkedOut
            label="How profit by line is worked out"
            lines={profitExplained(facts.profit, lineName)}
            change={{ href: `${base}/settings/money/profit#split`, label: "Change the split" }}
          />
        )}
        {stepItems("expenses")}
      </SetupStepCard>

      {/* 6. Review */}
      <SetupStepCard
        {...stepProps("review")}
        description="Where things stand now, and what's still open."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {hasLines(revenue)
              ? `Sales are split into ${revenue.lines.length} business lines.`
              : "All sales count as one business."}
          </li>
          {debtView && debtView.totals && (
            <li>
              {debtView.debts.length === 0
                ? "No debts to pay down."
                : debtView.result.chosen.capped
                  ? "At these payments the debts take more than five years to clear."
                  : `On the plan, the debts are cleared in ${debtView.result.chosen.monthsToFreedom} months.`}
            </li>
          )}
        </ul>
        {debtView && (
          <HowWorkedOut
            label="Which order the plan pays debts in"
            lines={orderExplained({
              from: debtView.strategyFrom,
              strategy: debtView.strategy,
              recommendation: debtView.recommendation,
              money,
            })}
            change={{ href: `${base}/dashboard/debts#order`, label: "See the order" }}
          />
        )}
        {open.length === 0 ? (
          <p className="text-sm">
            Nothing left to set up. Your figures are as true as we can make them.
          </p>
        ) : (
          <>
            <p className="text-sm font-medium">Still open</p>
            <SetupList slug={tenant.slug} tool={MONEY_TOOL} items={open} canSnooze={canEdit} />
          </>
        )}
        {resting.length > 0 && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm">
              You said &ldquo;not now&rdquo; to {resting.length}
            </summary>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {resting.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{item.title}</span>
                  {canEdit && (
                    <NotNowButton
                      slug={tenant.slug}
                      tool={MONEY_TOOL}
                      item={item.id}
                      facts={item.facts}
                      back
                    />
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        <Button asChild className="w-fit">
          <Link href={`${base}/dashboard`}>See your Money page</Link>
        </Button>
      </SetupStepCard>
    </>
  );
}
