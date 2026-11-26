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
