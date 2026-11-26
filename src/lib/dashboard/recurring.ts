import { z } from "zod";
import { addMonths } from "./budget";
import { DASHBOARD_MODULE } from "./schema";

/**
 * The cost cutter's recurring-charge finder, the earlier finance
 * dashboard's rule (`useRecurringSpend.ts`), on whole cents:
 *
 * - expenses from the books over the last twelve months (this one
 *   included), money going out only: moves between the business's own
 *   accounts, expenses set aside as not the business's, refunds and
 *   anything the workspace leaves out never count;
 * - grouped by payee, with the spellings of one payee folded together
 *   ("Acme.com", "ACME INC", "acme") so one decision covers them all;
 * - a payee seen in three or more different months is recurring;
 * - its monthly cost = what it charged ÷ the months it charged in; yearly
 *   = that × 12;
 * - its trend = the average month in the last six against the six before;
 *   flags for growing fast, creeping up, new, stopped and (once the
 *   workspace sets the amounts) small but adding up, and for more than one
 *   recurring payee charging to the same account.
 *
 * The dashboard also reads a real merchant out of one bank's memo shapes;
 * that is one bank's format, so it is left out. What to leave out and every
 * threshold are this config (`dashboard` / `cost_cutter`): never a payee,
 * bank or account name in code. Pure.
 */
export const CUTTER_MODULE = DASHBOARD_MODULE;
export const CUTTER_KEY = "cost_cutter";

const name = z.string().trim().min(1).max(200);
const cents = z.number().int().min(1).max(100_000_000);

export const cutterSettingsSchema = z.object({
  version: z.literal(1),
  /** How far back to look, this month included. */
  months_back: z.number().int().min(3).max(24).default(12),
  /** Charged in at least this many different months to count as recurring. */
  min_months: z.number().int().min(2).max(12).default(3),
  /** Accounts never counted (their whole name; capitals and spacing don't matter). */
  leave_out_accounts: z.array(name).max(100).default([]),
  /** Payees never counted (the payee's name contains these words). */
  leave_out_payees: z.array(name).max(100).default([]),
  growing_fast_pct: z.number().int().min(1).max(500).default(25),
  creeping_pct: z.number().int().min(1).max(500).default(5),
  /** First charged within this many months before this one: new. */
  new_months: z.number().int().min(0).max(12).default(2),
  /** No charge for this many days: stopped billing. */
  stopped_days: z.number().int().min(7).max(365).default(60),
  /** Small but adds up: under this a month and at least `adds_up_cents` a year. Off until both are set. */
  small_cents: cents.nullable().default(null),
  adds_up_cents: cents.nullable().default(null),
});
export type CutterSettings = z.infer<typeof cutterSettingsSchema>;

export const DEFAULT_CUTTER_SETTINGS: CutterSettings = cutterSettingsSchema.parse({ version: 1 });

export function parseCutterSettings(body: unknown): CutterSettings {
  const parsed = cutterSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_CUTTER_SETTINGS;
}

export const DECISIONS = ["keep", "review", "cancel", "cancelled"] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_WORDS: Record<Decision, string> = {
  keep: "Keep",
  review: "Look into it",
  cancel: "Cancel it",
  cancelled: "Cancelled",
};

export const FLAGS = ["growing", "creeping", "new", "stopped", "small", "overlap"] as const;
export type Flag = (typeof FLAGS)[number];

export const FLAG_WORDS: Record<Flag, string> = {
  growing: "Growing fast",
  creeping: "Price creeping up",
  new: "New",
  stopped: "Stopped billing",
  small: "Small but adds up",
  overlap: "Others on the same account",
};

/**
 * One payee's spellings folded together: capitals, a card processor's
 * prefix, web endings, company words and trailing reference numbers go.
 */
export function foldPayee(payee: string): string {
  return payee
    .toLowerCase()
    .replace(/^(sq|sp|tst|pp|pos|ach|bts)[\s*]+/i, "")
    .replace(/\.(com|net|io|co|ai|org)\b/g, "")
    .replace(/\b(inc|llc|ltd|corp|co|company|the)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+\d[\d\s-]*$/, "")
    .trim();
}

/** One expense as the finder reads it (from `book_expenses`). */
export type SpendRow = {
  txn_date: string;
  amount_cents: number;
  payee: string | null;
  account: string | null;
  sort: string | null;
};

export type RecurringCharge = {
  key: string;
  payee: string;
  /** The account it charges most to; `accounts` lists every one. */
  account: string;
  accounts: string[];
  total: number;
  monthly: number;
  yearly: number;
  charges: number;
  monthsSeen: number;
  firstSeen: string;
  lastSeen: string;
  /** The last six months' average against the six before; null without both. */
  trend: number | null;
  flags: Flag[];
};

const same = (a: string, b: string) =>
  a.trim().replace(/\s+/g, " ").toLowerCase() === b.trim().replace(/\s+/g, " ").toLowerCase();

const dayNumber = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** The first day the finder reads from, for `today` (a plain day in the workspace's timezone). */
export function cutterSince(today: string, settings: CutterSettings): string {
  return `${addMonths(today.slice(0, 7), -(settings.months_back - 1))}-01`;
}

/**
 * Recurring charges in `rows`, biggest yearly cost first. `today` is a
 * plain day, `YYYY-MM-DD`, in the workspace's timezone.
 */
export function findRecurring(
  rows: readonly SpendRow[],
  today: string,
  settings: CutterSettings,
): RecurringCharge[] {
  const thisMonth = today.slice(0, 7);
  const since = cutterSince(today, settings);
  const leaveOutWords = settings.leave_out_payees
    .map((w) => w.trim().toLowerCase())
    .filter(Boolean);

  type Group = { key: string; payee: string; byAccount: Map<string, number>; charges: SpendRow[] };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.txn_date < since || row.txn_date > today) continue;
    if (row.amount_cents <= 0 || row.sort === "set_aside") continue;
    const account = (row.account ?? "").trim();
    const payee = (row.payee ?? "").trim();
    if (!account && !payee) continue;
    if (account && settings.leave_out_accounts.some((one) => same(one, account))) continue;
    const named = payee || account;
    if (leaveOutWords.some((word) => named.toLowerCase().includes(word))) continue;
    const key = foldPayee(named) || named.toLowerCase();
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { key, payee: named, byAccount: new Map(), charges: [] }));
    if (account)
      group.byAccount.set(account, (group.byAccount.get(account) ?? 0) + row.amount_cents);
    group.charges.push(row);
  }

  const half = addMonths(thisMonth, -5);
  const newFrom = `${addMonths(thisMonth, -settings.new_months)}-01`;
  const found: RecurringCharge[] = [];
  for (const group of groups.values()) {
    const months = new Set(group.charges.map((c) => c.txn_date.slice(0, 7)));
    if (months.size < settings.min_months) continue;
    const total = group.charges.reduce((sum, c) => sum + c.amount_cents, 0);
    const monthly = Math.round(total / months.size);
    const dates = group.charges.map((c) => c.txn_date).sort();

    const recent = group.charges.filter((c) => c.txn_date.slice(0, 7) >= half);
    const prior = group.charges.filter((c) => c.txn_date.slice(0, 7) < half);
    const monthsOf = (list: SpendRow[]) => new Set(list.map((c) => c.txn_date.slice(0, 7))).size;
    const average = (list: SpendRow[]) =>
      list.reduce((sum, c) => sum + c.amount_cents, 0) / Math.max(1, monthsOf(list));
    const trend =
      recent.length > 0 && prior.length > 0 && average(prior) > 0
        ? (average(recent) - average(prior)) / average(prior)
        : null;

    const flags: Flag[] = [];
    if (trend !== null && trend >= settings.growing_fast_pct / 100) flags.push("growing");
    else if (trend !== null && trend >= settings.creeping_pct / 100) flags.push("creeping");
    if (dates[0] >= newFrom) flags.push("new");
    if (dayNumber(today) - dayNumber(dates.at(-1)!) > settings.stopped_days) flags.push("stopped");
    if (
      settings.small_cents !== null &&
      settings.adds_up_cents !== null &&
      monthly < settings.small_cents &&
      monthly * 12 >= settings.adds_up_cents
    ) {
      flags.push("small");
    }

    const accounts = [...group.byAccount.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
    found.push({
      key: group.key,
      payee: group.payee,
      account: accounts[0]?.[0] ?? "",
      accounts: accounts.map(([account]) => account).sort(),
      total,
      monthly,
      yearly: monthly * 12,
      charges: group.charges.length,
      monthsSeen: months.size,
      firstSeen: dates[0],
      lastSeen: dates.at(-1)!,
      trend,
      flags,
    });
  }

  // More than one recurring payee on the same account may be doing one job.
  const perAccount = new Map<string, number>();
  for (const charge of found) {
    if (charge.account) perAccount.set(charge.account, (perAccount.get(charge.account) ?? 0) + 1);
  }
  for (const charge of found) {
    if (charge.account && (perAccount.get(charge.account) ?? 0) > 1) charge.flags.push("overlap");
  }
  return found.sort((a, b) => b.yearly - a.yearly || a.key.localeCompare(b.key));
}

export type ChargeDecision = {
  key: string;
  decision: Decision;
  decided_at: string;
  note: string | null;
};

export type CutterSummary = {
  monthly: number;
  yearly: number;
  payees: number;
  /** Recurring spend ÷ average monthly revenue; null without revenue. */
  shareOfRevenue: number | null;
  /** Monthly cost of what's marked to cancel or cancelled. */
  savingsPlanned: number;
  /** Marked cancelled, yet charged again since. */
  stillBilling: string[];
};

/** The headline over the list, with each charge's decision. */
export function cutterSummary(
  charges: readonly RecurringCharge[],
  decisions: readonly ChargeDecision[],
  averageRevenue: number | null,
): CutterSummary {
  const byKey = new Map(decisions.map((d) => [d.key, d]));
  const monthly = charges.reduce((sum, c) => sum + c.monthly, 0);
  return {
    monthly,
    yearly: monthly * 12,
    payees: charges.length,
    shareOfRevenue: averageRevenue && averageRevenue > 0 ? monthly / averageRevenue : null,
    savingsPlanned: charges
      .filter((c) => {
        const d = byKey.get(c.key)?.decision;
        return d === "cancel" || d === "cancelled";
      })
      .reduce((sum, c) => sum + c.monthly, 0),
    stillBilling: charges
      .filter((c) => {
        const d = byKey.get(c.key);
        return d?.decision === "cancelled" && c.lastSeen > d.decided_at.slice(0, 10);
      })
      .map((c) => c.key),
  };
}
