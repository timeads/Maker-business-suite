import type { SupabaseClient } from "@supabase/supabase-js";
import { averageCents, bookMonthOf, completeMonths, type BookMonth } from "../health";
import { currentMonth } from "../range";
import {
  debtCards,
  debtPlan,
  emergencyReached,
  milestones,
  planPayoffs,
  type DebtCard,
  type DebtPlan,
  type Milestone,
  type PlanInput,
  type PlanOverride,
  type Strategy,
} from "./engine";
import {
  afterDebt,
  debtTotals,
  emergencyFund,
  toPlanDebt,
  type AfterDebt,
  type Debt,
  type DebtTotals,
  type EmergencyFund,
} from "./figures";
import { liabilityTypeWords } from "./books";
import { DEBT_KEY, DEBT_MODULE, parseDebtSettings, type DebtSettings } from "./settings";

/**
 * Loading the debts and everything worked out from them, always as the
 * signed-in member: row-level security hands owners and admins their
 * workspace's debts and everyone else nothing at all, so a page or widget
 * built on these has nothing to show anyone else even if it asked.
 */

const num = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : 0;
};
const numOrNull = (value: unknown) => (value === null || value === undefined ? null : num(value));

/** The debt plan's setting (owners and admins only; the defaults for anyone else). */
export async function loadDebtSettings(
  supabase: SupabaseClient,
  tenantId: string,
): Promise<DebtSettings> {
  const { data, error } = await supabase
    .from("configs")
    .select("body")
    .eq("tenant_id", tenantId)
    .eq("module", DEBT_MODULE)
    .eq("key", DEBT_KEY)
    .maybeSingle();
  if (error) throw new Error(`Could not load the debt settings: ${error.message}`);
  return parseDebtSettings(data?.body);
}

/** Every debt with its latest balance. Empty for anyone but owners and admins. */
export async function loadDebts(supabase: SupabaseClient, tenantId: string): Promise<Debt[]> {
  const [debts, current] = await Promise.all([
    supabase
      .from("money_debts")
      .select(
        "id, name, kind, plan, status, rate_bp, minimum_cents, payment_cents, revolving_bp, due_day, priority, opening_cents, books_account, note, source, book_account_id",
      )
      .eq("tenant_id", tenantId)
      // "Not a debt": out of every list and figure.
      .is("left_out_at", null)
      .order("priority", { ascending: true, nullsFirst: false })
      .order("name")
      .limit(200),
    supabase.rpc("money_debt_current", { p_tenant_id: tenantId }),
  ]);
  if (debts.error) throw new Error(`Could not load the debts: ${debts.error.message}`);
  if (current.error) throw new Error(`Could not load the balances: ${current.error.message}`);
  const latest = new Map(
    ((current.data as Record<string, unknown>[] | null) ?? []).map((row) => [
      String(row.debt_id),
      row,
    ]),
  );
  return ((debts.data as Record<string, unknown>[] | null) ?? []).map((row) => {
    const balance = latest.get(String(row.id));
    return {
      id: String(row.id),
      name: String(row.name),
      kind: String(row.kind),
      plan: row.plan as Debt["plan"],
      status: row.status as Debt["status"],
      rateBp: num(row.rate_bp),
      minimum: num(row.minimum_cents),
      payment: numOrNull(row.payment_cents),
      revolvingBp: numOrNull(row.revolving_bp),
      dueDay: numOrNull(row.due_day),
      priority: numOrNull(row.priority),
      opening: numOrNull(row.opening_cents),
      booksAccount: (row.books_account as string | null) ?? null,
      note: (row.note as string | null) ?? null,
      source: row.source === "books" ? "books" : "person",
      bookAccountId: (row.book_account_id as string | null) ?? null,
      needsRate: row.rate_bp === null || row.rate_bp === undefined,
      balance: balance ? num(balance.balance_cents) : null,
      balanceAsOf: balance ? String(balance.as_of) : null,
      balanceFrom: balance ? (balance.source as "person" | "books") : null,
    };
  });
}

/** One of the books' other liabilities, for "Also in your books". */
export type OtherLiability = {
  id: string;
  name: string;
  /** What the books call it ("Sales Tax Payable"). */
  typeWords: string;
  /** Signed as the books show it; owed is positive. */
  balance: number;
  asOf: string | null;
  /** A person said "Not a debt" (else the rule leaves it out). */
  markedNotDebt: boolean;
  /** A person hid it from the list (only the list: it changes nothing else). */
  hidden: boolean;
};

export type BooksState = {
  /** QuickBooks is connected and working. */
  connected: boolean;
  /** When the books' liabilities were last read for the debts (else the last sync). */
  lastRead: string | null;
  /** Liabilities in the books that aren't debts here, biggest first, not hidden. */
  others: OtherLiability[];
  /** The ones a person hid, for "Hidden (n)". */
  hidden: OtherLiability[];
};

/**
 * Where the debts come from: whether the books are connected, when they
 * were last read, and the liabilities that aren't counted as debts. As the
 * member: owners and admins only, by row-level security.
 */
export async function loadBooksState(
  supabase: SupabaseClient,
  tenantId: string,
  debts: readonly Debt[],
): Promise<BooksState> {
  const [accounts, connection] = await Promise.all([
    supabase
      .from("money_book_accounts")
      .select(
        "id, name, account_type, account_subtype, section, balance_cents, as_of, choice, seen_at, hidden_at",
      )
      .eq("tenant_id", tenantId)
      .is("gone_at", null)
      .order("seen_at", { ascending: false })
      .limit(1000),
    supabase
      .from("connections")
      .select("status, last_synced_at")
      .eq("tenant_id", tenantId)
      .eq("provider", "quickbooks")
      .maybeSingle(),
  ]);
  if (accounts.error)
    throw new Error(`Could not load the books' accounts: ${accounts.error.message}`);
  const rows = (accounts.data as Record<string, unknown>[] | null) ?? [];
  const shown = new Set(debts.map((d) => d.bookAccountId).filter(Boolean));
  const others = rows
    .filter((row) => !shown.has(String(row.id)))
    .map((row) => ({
      id: String(row.id),
      name: String(row.name),
      typeWords: liabilityTypeWords({
        type: (row.account_type as string | null) ?? null,
        subtype: (row.account_subtype as string | null) ?? null,
        section: (row.section as string | null) ?? null,
      }),
      balance: num(row.balance_cents),
      asOf: (row.as_of as string | null) ?? null,
      markedNotDebt: row.choice === "not_debt",
      hidden: row.hidden_at !== null && row.hidden_at !== undefined,
    }))
    .sort((a, b) => b.balance - a.balance || a.name.localeCompare(b.name));
  const conn = connection.error ? null : (connection.data as Record<string, unknown> | null);
  return {
    connected: conn?.status === "active",
    lastRead:
      (rows[0]?.seen_at as string | undefined) ??
      (conn?.last_synced_at as string | null | undefined) ??
      null,
    others: others.filter((o) => !o.hidden),
    hidden: others.filter((o) => o.hidden),
  };
}

/** What the books show paid into each debt's own account, per month. */
export async function loadDebtPayments(
  supabase: SupabaseClient,
  tenantId: string,
  from: string,
  to: string,
): Promise<{ debtId: string; month: string; cents: number }[]> {
  const { data, error } = await supabase.rpc("money_debt_payments", {
    p_tenant_id: tenantId,
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(`Could not load the debt payments: ${error.message}`);
  return ((data as Record<string, unknown>[] | null) ?? []).map((row) => ({
    debtId: String(row.debt_id),
    month: String(row.month).slice(0, 7),
    cents: num(row.cents),
  }));
}

export type DebtPayment = {
  debtId: string;
  date: string;
  cents: number;
  fromAccount: string | null;
};

export type SavedWhatIf = {
  id: string;
  question: string;
  changes: Record<string, unknown>;
  figures: Record<string, unknown>;
  savedAt: string;
};

export type DebtView = {
  current: string;
  settings: DebtSettings;
  debts: Debt[];
  totals: DebtTotals;
  /** Debts with no balance yet: the plan leaves them out until one is given. */
  noBalance: Debt[];
  /** Debts owing something with no rate given yet: the plan counts them at 0%. */
  noRate: Debt[];
  /** The plan's figures as the engine takes them, for a what-if to change a copy of. */
  input: PlanInput & { strategy: Strategy; hybridThreshold: number };
  result: DebtPlan;
  payoffs: Map<string, string | null>;
  milestones: Milestone[];
  cards: DebtCard[];
  emergency: EmergencyFund;
  emergencyAt: string | null;
  after: AfterDebt;
  overrides: Map<string, PlanOverride>;
  payments: DebtPayment[];
  whatIfs: SavedWhatIf[];
  books: { complete: BookMonth[]; averageRevenue: number };
};

/** Everything the debt pages show, as the member. Nothing derived is stored. */
export async function loadDebtView(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string },
  now: Date = new Date(),
): Promise<DebtView> {
  const current = currentMonth(now, tenant.timezone);
  const [settings, debts, months, books, sheet, payments, saved] = await Promise.all([
    loadDebtSettings(supabase, tenant.id),
    loadDebts(supabase, tenant.id),
    supabase
      .from("money_debt_plan_months")
      .select("month, pool_cents, emergency_cents")
      .eq("tenant_id", tenant.id)
      .gte("month", `${current}-01`)
      .order("month")
      .limit(240),
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "profit_and_loss")
      .order("period_start", { ascending: true })
      .limit(1000),
    supabase
      .from("financial_snapshots")
      .select("data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "balance_sheet")
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase.rpc("money_debt_payment_list", { p_tenant_id: tenant.id, p_limit: 60 }),
    supabase
      .from("money_debt_scenarios")
      .select("id, question, changes, figures, saved_at")
      .eq("tenant_id", tenant.id)
      .order("saved_at", { ascending: false })
      .limit(50),
  ]);
  for (const result of [months, books, sheet, payments, saved]) {
    if (result.error) throw new Error(`Could not load the debt plan: ${result.error.message}`);
  }

  const overrides = new Map<string, PlanOverride>(
    ((months.data as Record<string, unknown>[] | null) ?? []).map((row) => [
      String(row.month).slice(0, 7),
      { pool: numOrNull(row.pool_cents), emergency: numOrNull(row.emergency_cents) },
    ]),
  );
  const complete = completeMonths(
    ((books.data as { period_start: string; data: Record<string, unknown> }[] | null) ?? []).map(
      (row) => bookMonthOf({ period_start: row.period_start, data: row.data ?? {} }),
    ),
    current,
  );
  const averageRevenue = Math.max(0, averageCents(complete.slice(-12).map((m) => m.income)));
  const sheetData = (sheet.data as { data?: Record<string, unknown> } | null)?.data ?? null;
  const bankAccounts = Array.isArray(sheetData?.bank_accounts)
    ? (sheetData.bank_accounts as { name: string; cents: number }[])
    : null;
  const emergency = emergencyFund(settings, complete, bankAccounts);

  const input: DebtView["input"] = {
    debts: debts.map(toPlanDebt),
    start: current,
    averageRevenue,
    revenueSharePct: settings.revenue_share_pct,
    emergency: {
      target: emergency.target,
      current: emergency.current,
      splitPct: settings.emergency_split_pct,
      monthly: settings.emergency_monthly_cents,
    },
    overrides,
    strategy: settings.strategy,
    hybridThreshold: settings.hybrid_threshold_cents,
  };
  const result = debtPlan(input);

  return {
    current,
    settings,
    debts,
    totals: debtTotals(debts),
    input,
    noBalance: debts.filter((d) => d.balance === null && d.status !== "closed"),
    noRate: debts.filter((d) => d.needsRate && d.status === "active" && (d.balance ?? 0) > 0),
    result,
    payoffs: planPayoffs(
      result.plan,
      debts.map((d) => d.id),
    ),
    milestones: milestones(result.chosen, result.poolDebts, result.schedule),
    cards: debtCards(result.chosen, result.poolDebts),
    emergency,
    emergencyAt:
      emergency.target > 0
        ? (emergencyReached(result.plan, emergency.target)?.month ?? null)
        : null,
    after: afterDebt({
      debts,
      complete,
      compareMonths: 3,
      monthsToFreedom: result.chosen.capped ? null : result.chosen.monthsToFreedom,
    }),
    overrides,
    payments: ((payments.data as Record<string, unknown>[] | null) ?? []).map((row) => ({
      debtId: String(row.debt_id),
      date: String(row.txn_date),
      cents: num(row.cents),
      fromAccount: (row.from_account as string | null) ?? null,
    })),
    whatIfs: ((saved.data as Record<string, unknown>[] | null) ?? []).map((row) => ({
      id: String(row.id),
      question: String(row.question),
      changes: (row.changes as Record<string, unknown>) ?? {},
      figures: (row.figures as Record<string, unknown>) ?? {},
      savedAt: String(row.saved_at),
    })),
    books: { complete, averageRevenue },
  };
}
