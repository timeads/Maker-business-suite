/**
 * The boxes on Money's settings screens made of plain figures and lists
 * (cash health, budget and break-even, the cost cutter): which key of the
 * setting each edits, in words a maker reads. Amounts of money are typed in
 * the workspace's currency and kept in whole cents; lists are one per line.
 */
export type FigureField =
  | {
      kind: "number";
      key: string;
      label: string;
      help?: string;
      min: number;
      max: number;
      suffix?: string;
    }
  | {
      /** A whole number that may be left blank (null). */
      kind: "optional";
      key: string;
      label: string;
      help?: string;
      min: number;
      max: number;
      suffix?: string;
    }
  | { kind: "money"; key: string; label: string; help?: string }
  /** A money amount that may be left blank (null). */
  | { kind: "optional_money"; key: string; label: string; help?: string }
  | {
      kind: "choice";
      key: string;
      label: string;
      help?: string;
      options: { value: string; label: string }[];
    }
  | { kind: "list"; key: string; label: string; help?: string };

export type FigureGroup = { title: string; about?: string; fields: FigureField[] };

const pct = (key: string, label: string, help?: string, min = -100, max = 100): FigureField => ({
  kind: "number",
  key,
  label,
  help,
  min,
  max,
  suffix: "%",
});

export const HEALTH_FIELDS: FigureGroup[] = [
  {
    title: "What counts as recent",
    fields: [
      {
        kind: "number",
        key: "compare_months",
        label: "Recent months",
        help: "Growth compares these complete months with as many before; burn averages them.",
        min: 1,
        max: 6,
        suffix: "months",
      },
    ],
  },
  {
    title: "Healthy, or worth watching",
    about: "Below the second figure, Money says it needs attention.",
    fields: [
      {
        kind: "number",
        key: "runway_good_months",
        label: "Runway is healthy from",
        min: 1,
        max: 60,
        suffix: "months",
      },
      {
        kind: "number",
        key: "runway_watch_months",
        label: "Runway is worth watching from",
        min: 0,
        max: 60,
        suffix: "months",
      },
      pct("growth_good_pct", "Revenue growth is healthy above"),
      pct("growth_bad_pct", "Revenue growth is worth watching above"),
      pct("gross_margin_good_pct", "Gross margin is healthy above", undefined, 0),
      pct("gross_margin_watch_pct", "Gross margin is worth watching above", undefined, 0),
      pct(
        "concentration_watch_pct",
        "One line's share is worth watching from",
        "How much of your revenue one business line brings in.",
        1,
      ),
    ],
  },
  {
    title: "The plain notes",
    about: "What's going well, what to watch and what's worth doing are written from these.",
    fields: [
      pct("thin_margin_pct", "Call the operating margin thin under"),
      pct("concentrated_pct", "Warn when one line brings in more than", undefined, 1),
      pct("grow_lines_pct", "Suggest growing the others above", undefined, 1),
      pct("check_cogs_pct", "Suggest looking at cost of goods under a margin of", undefined, 0),
      {
        kind: "number",
        key: "margin_lift_pct",
        label: "…and work out what this much more margin would add",
        min: 1,
        max: 50,
        suffix: "points",
      },
    ],
  },
];

export const BUDGET_FIELDS: FigureGroup[] = [
  {
    title: "Cost of goods and break-even",
    about:
      "Break-even is your fixed costs budgeted ÷ (1 − cost of goods share). Costs that rise and fall with sales aren't fixed.",
    fields: [
      {
        kind: "optional",
        key: "cogs_pct",
        label: "Cost of goods share of revenue",
        help: "Leave blank to take it from your books' last twelve complete months.",
        min: 0,
        max: 95,
        suffix: "%",
      },
      {
        kind: "list",
        key: "variable_accounts",
        label: "Accounts that rise and fall with sales",
        help: "Their whole names as your books have them, one per line (what you buy to resell, freight in…). Spending more here usually means selling more.",
      },
    ],
  },
  {
    title: "The budget page",
    fields: [
      pct("warn_pct", "Flag spending over or under budget by more than", undefined, 1),
      {
        kind: "number",
        key: "average_months",
        label: "Show the average of the last",
        min: 1,
        max: 12,
        suffix: "complete months",
      },
      {
        kind: "list",
        key: "hidden_accounts",
        label: "Accounts left off the budget",
        help: "Whole names, one per line: owner's draws, money held for others, anything that isn't a running cost.",
      },
    ],
  },
];

export const CUTTER_FIELDS: FigureGroup[] = [
  {
    title: "What counts as recurring",
    fields: [
      {
        kind: "number",
        key: "months_back",
        label: "Look over the last",
        min: 3,
        max: 24,
        suffix: "months",
      },
      {
        kind: "number",
        key: "min_months",
        label: "Recurring when charged in at least",
        min: 2,
        max: 12,
        suffix: "different months",
      },
      {
        kind: "list",
        key: "leave_out_accounts",
        label: "Accounts to leave out",
        help: "Whole names, one per line: wages, loan payments, stock you resell, tax — anything that isn't a bill you could cancel.",
      },
      {
        kind: "list",
        key: "leave_out_payees",
        label: "Payees to leave out",
        help: "A payee whose name contains any of these words, one per line.",
      },
    ],
  },
  {
    title: "Flags",
    fields: [
      pct(
        "growing_fast_pct",
        "Growing fast from",
        "The last six months' average against the six before.",
        1,
        500,
      ),
      pct("creeping_pct", "Price creeping up from", undefined, 1, 500),
      {
        kind: "number",
        key: "new_months",
        label: "New when first charged within",
        min: 0,
        max: 12,
        suffix: "months",
      },
      {
        kind: "number",
        key: "stopped_days",
        label: "Stopped when nothing's charged for",
        min: 7,
        max: 365,
        suffix: "days",
      },
      {
        kind: "money",
        key: "small_cents",
        label: "Small: under this a month",
        help: "Set both of these to flag small charges that add up over a year.",
      },
      { kind: "money", key: "adds_up_cents", label: "…that comes to at least this a year" },
    ],
  },
];

/** Settings → Money → Debt payoff and emergency fund (owners and admins only). */
export const DEBT_FIELDS: FigureGroup[] = [
  {
    title: "Debts from your books",
    about:
      "Each time QuickBooks syncs, the accounts on your balance sheet of these kinds become debts by themselves. Other things you owe (bills to suppliers, sales tax, payroll) are listed on Debts, where you can count any of them.",
    fields: [
      {
        kind: "list",
        key: "books_debt_types",
        label: "Kinds of account that are debts",
        help: "As QuickBooks names its account types and detail types, one per line: Credit Card, Long Term Liability, Line Of Credit, Loan Payable, Notes Payable. Changes show at the next sync.",
      },
    ],
  },
  {
    title: "Where extra money goes",
    about:
      "The plan pays every debt its minimum. What's freed as each one is paid off goes to the next, in this order.",
    fields: [
      {
        kind: "choice",
        key: "strategy",
        label: "Order",
        options: [
          { value: "avalanche", label: "Avalanche: highest rate first" },
          { value: "snowball", label: "Snowball: smallest balance first" },
          { value: "hybrid", label: "Hybrid: small balances, then highest rate" },
          { value: "custom", label: "Your own order (each debt's place)" },
        ],
      },
      {
        kind: "money",
        key: "hybrid_threshold_cents",
        label: "Hybrid: clear balances up to this first",
      },
      pct(
        "revenue_share_pct",
        "A share-of-sales debt with no payment set pays",
        "Of your average monthly revenue.",
        0,
      ),
    ],
  },
  {
    title: "Emergency fund",
    about:
      "Until the fund reaches its target, part of the freed payments goes into it first. Once every debt the plan pays down is gone, all of it does.",
    fields: [
      {
        kind: "choice",
        key: "emergency_target",
        label: "Aim for",
        options: [
          { value: "months", label: "Months of my usual expenses" },
          { value: "amount", label: "An amount I choose" },
        ],
      },
      {
        kind: "number",
        key: "emergency_months",
        label: "Months of expenses",
        help: "Your usual month is worked out from the last twelve complete months in your books.",
        min: 1,
        max: 24,
        suffix: "months",
      },
      { kind: "money", key: "emergency_target_cents", label: "Or this amount" },
      {
        kind: "list",
        key: "emergency_accounts",
        label: "Bank accounts the fund is kept in",
        help: "Their names as your books' balance sheet has them, one per line. The fund's balance is read from them each time your books sync.",
      },
      {
        kind: "optional_money",
        key: "emergency_current_cents",
        label: "With no account: what's in the fund now",
      },
      pct("emergency_split_pct", "Share of freed payments into the fund", undefined, 0),
      {
        kind: "money",
        key: "emergency_monthly_cents",
        label: "Or a set amount a month",
        help: "Leave at 0 to use the share above.",
      },
    ],
  },
  {
    title: "Cash health",
    about:
      "Where the two debt tiles count as healthy or worth watching; beyond the second, needs attention.",
    fields: [
      pct(
        "debt_revenue_good_pct",
        "Debt is healthy under this share of a year's revenue",
        undefined,
        0,
        1000,
      ),
      pct("debt_revenue_watch_pct", "…and worth watching under", undefined, 0, 1000),
      {
        kind: "number",
        key: "coverage_good_x100",
        label: "Profit covers the payments healthily above",
        help: "In hundredths: 150 means one and a half times.",
        min: 0,
        max: 10_000,
        suffix: "hundredths",
      },
      {
        kind: "number",
        key: "coverage_watch_x100",
        label: "…and is worth watching above",
        min: 0,
        max: 10_000,
        suffix: "hundredths",
      },
    ],
  },
  {
    title: "The plain notes",
    fields: [
      pct("high_debt_pct", "Mention debt above this share of a year's revenue", undefined, 0, 1000),
      pct("extra_margin_pct", "Suggest sending extra with an operating margin above", undefined, 0),
      pct("extra_debt_pct", "…and debt above this share of a year's revenue", undefined, 0, 1000),
    ],
  },
];
