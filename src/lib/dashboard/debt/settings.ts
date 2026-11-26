import { z } from "zod";
import { DASHBOARD_MODULE } from "../schema";
import { STRATEGIES } from "./engine";

/** Kept in step with `DEFAULT_BOOKS_DEBT_TYPES` in `books.ts` (a test holds them equal). */
const BOOKS_DEBT_TYPES = [
  "Credit Card",
  "Long Term Liability",
  "Line Of Credit",
  "Loan Payable",
  "Notes Payable",
];

/**
 * How the debt payoff plan and the emergency fund are worked out: a config
 * (`dashboard` / `debt`), set under Settings → Money → Debt payoff. It is
 * one of the settings only owners and admins can read (the database hides
 * it from everyone else: `private.config_owners_only`), because its figures
 * say what the business owes and keeps aside.
 *
 * The defaults are the earlier dashboard's, except the emergency target,
 * which starts as months of expenses rather than a typed amount.
 */
export const DEBT_MODULE = DASHBOARD_MODULE;
export const DEBT_KEY = "debt";

const cents = z.number().int().min(0).max(100_000_000_000);
const pct = (fallback: number) => z.number().int().min(0).max(100).default(fallback);

export const debtSettingsSchema = z
  .object({
    version: z.literal(1),
    /** Which order extra money goes in. */
    strategy: z.enum(STRATEGIES).default("avalanche"),
    /** Hybrid: balances at or under this are cleared first. */
    hybrid_threshold_cents: cents.default(100_000),
    /** A share-of-revenue debt with no payment typed in takes this whole percent of average revenue. */
    revenue_share_pct: pct(7),

    /** The emergency fund's target: an amount, or months of the business's usual expenses. */
    emergency_target: z.enum(["amount", "months"]).default("months"),
    emergency_target_cents: cents.default(0),
    emergency_months: z.number().int().min(1).max(24).default(6),
    /**
     * The books' bank accounts the fund is kept in, picked from the latest
     * balance sheet: by the books' own id where the sheet gives one, else by
     * the name. Never an account name or number in code.
     */
    emergency_picks: z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,60}$/)
            .nullable()
            .default(null),
          name: z.string().trim().min(1).max(200),
        }),
      )
      .max(10)
      .default([]),
    /** Earlier: the accounts typed in by name. Still read; the picker replaces them. */
    emergency_accounts: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
    /** With no account chosen: what's in the fund, typed in. */
    emergency_current_cents: cents.nullable().default(null),
    /** Share of the pool set aside until the target is reached… */
    emergency_split_pct: pct(30),
    /** …or a fixed amount a month instead (0 uses the share). */
    emergency_monthly_cents: cents.default(0),

    /** Debt ÷ a year's revenue: healthy under the first, worth watching under the second. */
    debt_revenue_good_pct: z.number().int().min(0).max(1000).default(30),
    debt_revenue_watch_pct: z.number().int().min(0).max(1000).default(60),
    /** How many times profit covers the payments, in hundredths (150 = 1.5×). */
    coverage_good_x100: z.number().int().min(0).max(10_000).default(150),
    coverage_watch_x100: z.number().int().min(0).max(10_000).default(110),
    /** Notes: debt above this share of a year's revenue is worth watching. */
    high_debt_pct: z.number().int().min(0).max(1000).default(50),
    /** Notes: with an operating margin above this and debt above the next, suggest sending extra. */
    extra_margin_pct: pct(10),
    extra_debt_pct: z.number().int().min(0).max(1000).default(40),

    /**
     * Which of the books' liability accounts become debts by themselves: the
     * books' account types or detail types (spacing and capitals ignored).
     * Never an account, bank or lender name. Others can still be counted on
     * Money → Debts.
     */
    books_debt_types: z
      .array(z.string().trim().min(1).max(60))
      .max(30)
      .default(() => [...BOOKS_DEBT_TYPES]),
  })
  .superRefine((value, ctx) => {
    if (value.debt_revenue_good_pct > value.debt_revenue_watch_pct) {
      ctx.addIssue({
        code: "custom",
        path: ["debt_revenue_good_pct"],
        message: "The healthy share of revenue can't be above the 'keep an eye on' one",
      });
    }
    if (value.coverage_watch_x100 > value.coverage_good_x100) {
      ctx.addIssue({
        code: "custom",
        path: ["coverage_watch_x100"],
        message: "The 'keep an eye on' cover can't be above the healthy one",
      });
    }
  });
export type DebtSettings = z.infer<typeof debtSettingsSchema>;

export const DEFAULT_DEBT_SETTINGS: DebtSettings = debtSettingsSchema.parse({ version: 1 });

export function parseDebtSettings(body: unknown): DebtSettings {
  const parsed = debtSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_DEBT_SETTINGS;
}

// ---------------------------------------------------------------------------
// A debt as typed in
// ---------------------------------------------------------------------------

export const DEBT_KINDS = ["card", "loan", "line_of_credit", "other"] as const;
export type DebtKind = (typeof DEBT_KINDS)[number];
export const DEBT_KIND_WORDS: Record<DebtKind, string> = {
  card: "Credit card",
  loan: "Loan",
  line_of_credit: "Line of credit",
  other: "Something else",
};

export const DEBT_STATUSES = ["active", "paused", "closed"] as const;
export type DebtStatus = (typeof DEBT_STATUSES)[number];
export const DEBT_STATUS_WORDS: Record<DebtStatus, string> = {
  active: "In the plan",
  paused: "On hold",
  closed: "Closed",
};

export const PLAN_KIND_WORDS = {
  pool: "Paid down by the plan",
  fixed: "Fixed payment",
  revenue_share: "Share of sales",
} as const;

/** A percent typed with up to two decimals ("22.99"), as basis points; null when it isn't one. */
export function percentToBp(text: string): number | null {
  const clean = text.trim().replace(/%$/, "").trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, part = ""] = clean.split(".");
  const bp = Number(whole) * 100 + Number(part.padEnd(2, "0"));
  return bp <= 100_000 ? bp : null;
}

/** Basis points as a percent for people: 2299 → "22.99%", 1800 → "18%". */
export function bpWords(bp: number): string {
  const whole = Math.floor(bp / 100);
  const part = bp % 100;
  return part === 0 ? `${whole}%` : `${whole}.${String(part).padStart(2, "0").replace(/0$/, "")}%`;
}

export const debtFieldsSchema = z.object({
  name: z.string().trim().min(1, "Give it a name").max(80),
  kind: z.enum(DEBT_KINDS),
  plan: z.enum(["pool", "fixed", "revenue_share"]),
  status: z.enum(DEBT_STATUSES),
  rate_bp: z.number().int().min(0).max(100_000).nullable(),
  minimum_cents: cents,
  payment_cents: cents.nullable(),
  revolving_bp: z.number().int().min(1).max(10_000).nullable(),
  due_day: z.number().int().min(1).max(31).nullable(),
  priority: z.number().int().min(1).max(999).nullable(),
  opening_cents: cents.nullable(),
  books_account: z.string().trim().max(200).nullable(),
  note: z.string().trim().max(500).nullable(),
});
export type DebtFields = z.infer<typeof debtFieldsSchema>;
