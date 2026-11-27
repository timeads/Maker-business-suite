import type { SupabaseClient } from "@supabase/supabase-js";
import { invoiceAccounts as mergeInvoiceAccounts } from "./book-revenue";
import type { BooksRevenue } from "./lines";

const invoiceAccountRows = (books: BooksRevenue, rows: Record<string, unknown>[]) =>
  mergeInvoiceAccounts(
    books,
    rows.map((row) => ({
      account_ref: (row.account_ref as string | null) ?? null,
      account: (row.account as string | null) ?? null,
      invoices: Number(row.invoices),
      cents: Number(row.cents),
    })),
  );
import { loadCutterSettings, loadProfitSettings } from "./data";
import { loadBooksState, loadDebtBook, loadDebtSettings } from "./debt/data";
import { foldPayments } from "./debt/plans";
import { DEBT_KEY, DEBT_MODULE } from "./debt/settings";
import { isPaidOff } from "./debt/figures";
import { accountsSummary, mergeAccounts, readAccountRows, yearBefore } from "./expense-accounts";
import { EXPENSES_KEY, EXPENSES_MODULE, parseExpenseSorting } from "./expenses";
import { DEFAULT_PROFIT_SETTINGS } from "./profit";
import { defaultLineCount, hasLines, type RecentLine, type RevenueSettings } from "./lines";
import { localDate, startOfLocalDay } from "./range";
import { cutterSince, findRecurring, type SpendRow } from "./recurring";
import {
  passThroughAccounts,
  type ConnectionFact,
  type MoneyDebtFacts,
  type MoneySetupFacts,
} from "./setup";

/**
 * The facts the Money checklist is worked out from, read as the member.
 * `deep` adds the two that cost a real read (recent orders against the
 * lines, the cost cutter's charges): only Money → Set up asks for them; the
 * Money page's card does without. Debts are read only for owners and admins
 * (`manager`), and even then row-level security is what hands them over.
 * Any part that fails is left out rather than stopping the page.
 */
export async function loadMoneySetupFacts(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  opts: { manager: boolean; revenue: RevenueSettings; deep?: boolean; now?: Date },
): Promise<MoneySetupFacts> {
  const now = opts.now ?? new Date();
  const local = localDate(now, tenant.timezone);
  const today = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;

  const [connections, profit, expenses, accounts, budget, debts, share, cutter, invoiceAccounts] =
    await Promise.all([
      supabase
        .from("connections")
        .select("provider, status, last_synced_at, last_error")
        .eq("tenant_id", tenant.id)
        .in("provider", ["quickbooks", "shopify"]),
      loadProfitSettings(supabase, tenant.id).catch(() => null),
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
      supabase
        .from("money_budgets")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", tenant.id),
      opts.manager ? loadDebtFacts(supabase, tenant.id).catch(() => null) : Promise.resolve(null),
      opts.deep && hasLines(opts.revenue)
        ? loadDefaultShare(supabase, tenant, opts.revenue, now).catch(() => null)
        : Promise.resolve(null),
      opts.deep
        ? loadCutterWaiting(supabase, tenant.id, today).catch(() => null)
        : Promise.resolve(null),
      // Only when paid invoices count: which of their income accounts have no choice yet.
      opts.revenue.books.invoices && hasLines(opts.revenue)
        ? Promise.resolve(
            supabase.rpc("money_invoice_accounts", {
              p_tenant_id: tenant.id,
              p_since: `${local.year - 3}-01-01`,
            }),
          ).then(
            ({ data, error }) =>
              error
                ? null
                : invoiceAccountRows(
                    opts.revenue.books,
                    (data as Record<string, unknown>[]) ?? [],
                  ).filter((a) => a.name !== null && a.choice === null).length,
            () => null,
          )
        : Promise.resolve(null),
    ]);

  const byProvider = new Map(
    ((connections.data ?? []) as Record<string, unknown>[]).map((row) => [
      String(row.provider),
      {
        status: row.status as ConnectionFact["status"],
        lastSyncedAt: (row.last_synced_at as string | null) ?? null,
        lastError: (row.last_error as string | null) ?? null,
      },
    ]),
  );
  const accountRows = accounts.error
    ? null
    : mergeAccounts(readAccountRows((accounts.data as Record<string, unknown>[] | null) ?? []));
  const summary = accountRows
    ? accountsSummary(
        parseExpenseSorting(expenses.data?.body),
        accountRows.filter((a) => a.name !== null),
      )
    : null;

  return {
    now,
    books: connections.error ? null : (byProvider.get("quickbooks") ?? null),
    shop: connections.error ? null : (byProvider.get("shopify") ?? null),
    revenue: opts.revenue,
    profit: profit ?? DEFAULT_PROFIT_SETTINGS,
    accounts: summary ? { total: summary.accounts, automatic: summary.automatic } : null,
    budgetRows: budget.error ? null : (budget.count ?? 0),
    defaultShare: share,
    cutterWaiting: cutter,
    invoiceAccountsWaiting: invoiceAccounts,
    debts,
  };
}

/** The debts' gaps, as owners and admins see them (everyone else is handed nothing). */
export async function loadDebtFacts(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<MoneyDebtFacts> {
  const [book, settings, saved, list] = await Promise.all([
    loadDebtBook(supabase, tenantId),
    loadDebtSettings(supabase, tenantId),
    supabase
      .from("configs")
      .select("key")
      .eq("tenant_id", tenantId)
      .eq("module", DEBT_MODULE)
      .eq("key", DEBT_KEY)
      .maybeSingle(),
    supabase.rpc("money_debt_payment_list", { p_tenant_id: tenantId, p_limit: 200 }),
  ]);
  const books = await loadBooksState(supabase, tenantId, book.debts);
  const owing = book.debts.filter(
    (d) => d.status === "active" && !isPaidOff(d) && (d.balance ?? 0) > 0,
  );
  const payments = foldPayments(
    ((list.data as Record<string, unknown>[] | null) ?? []).map((row) => ({
      debtId: String(row.debt_id),
      fromAccount: (row.from_account as string | null) ?? null,
    })),
    book,
  );
  const ref = (d: { id: string; name: string }) => ({ id: d.id, name: d.name });
  return {
    count: book.debts.filter((d) => d.status !== "closed" && !isPaidOff(d)).length,
    needsRate: owing.filter((d) => d.needsRate).map(ref),
    noPayment: owing
      .filter(
        (d) =>
          d.plan !== "revenue_share" &&
          d.minimum === 0 &&
          d.payment === null &&
          d.revolvingBp === null,
      )
      .map(ref),
    unlooked: books.others.filter((o) => !o.markedNotDebt).map(ref),
    passThrough: passThroughAccounts(
      books.others,
      payments,
      book.debts.filter((d) => !d.consolidated).map(ref),
    ),
    fundChosen:
      settings.emergency_picks.length > 0 ||
      settings.emergency_accounts.length > 0 ||
      settings.emergency_current_cents !== null,
    orderLooked: Boolean(saved.data) || settings.strategy_from === "person",
  };
}

const RECENT_DAYS = 90;
const PAGE = 1000;

/** The last ninety days' orders, and how many fell to the default line (as the lines page counts). */
async function loadDefaultShare(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  revenue: RevenueSettings,
  now: Date,
): Promise<{ orders: number; toDefault: number } | null> {
  const today = localDate(now, tenant.timezone);
  const d = new Date(Date.UTC(today.year, today.month - 1, today.day - RECENT_DAYS));
  const since = startOfLocalDay(
    { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() },
    tenant.timezone,
  );
  const rows: RecentLine[] = [];
  for (let page = 0; page < 5; page++) {
    const { data, error } = await supabase
      .rpc("money_recent_order_lines", { p_tenant_id: tenant.id, p_from: since.toISOString() })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return null;
    const batch = (data as RecentLine[] | null) ?? [];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }
  const count = defaultLineCount(revenue, rows);
  return { orders: count.orders, toDefault: count.toDefault };
}

/** Recurring charges the cost cutter finds that nobody has decided on yet. */
async function loadCutterWaiting(
  supabase: SupabaseClient,
  tenantId: string,
  today: string,
): Promise<number | null> {
  const settings = await loadCutterSettings(supabase, tenantId);
  const since = cutterSince(today, settings);
  const spend: SpendRow[] = [];
  for (let page = 0; page < 10; page++) {
    const { data, error } = await supabase
      .from("book_expenses")
      .select("txn_date, amount_cents, payee, account, sort")
      .eq("tenant_id", tenantId)
      .is("removed_at", null)
      .eq("is_move", false)
      .gt("amount_cents", 0)
      .gte("txn_date", since)
      .order("txn_date")
      .order("id")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return null;
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      spend.push({
        txn_date: String(row.txn_date),
        amount_cents: Number(row.amount_cents),
        payee: (row.payee as string | null) ?? null,
        account: (row.account as string | null) ?? null,
        sort: (row.sort as string | null) ?? null,
      });
    }
    if (batch.length < PAGE) break;
  }
  const { data, error } = await supabase
    .from("money_charge_decisions")
    .select("charge_key")
    .eq("tenant_id", tenantId)
    .limit(PAGE);
  if (error) return null;
  const decided = new Set(((data ?? []) as { charge_key: string }[]).map((r) => r.charge_key));
  return findRecurring(spend, today, settings).filter((c) => !decided.has(c.key)).length;
}
