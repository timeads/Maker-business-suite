import { STRATEGY_META, type Strategy } from "./debt/engine";
import { recommendationWords, type Recommendation } from "./debt/recommend";
import { actionWords, type ExpenseSorting, type SortAction } from "./expenses";
import { FIGURE_WORDS, MATCH_WORDS, hasLines, type RevenueSettings } from "./lines";
import type { ProfitSettings } from "./profit";
import type { ProjectionSettings } from "./projection";
import { someNames } from "../setup/items";

/**
 * "How this is worked out": plain words for Money's figures and the
 * decisions it makes by itself, built only from the workspace's own
 * settings and facts. Pure, no model. Each returns the lines to show; the
 * page puts the link that changes the setting beside them.
 */

const quoted = (words: readonly string[]) => someNames(words.map((w) => `“${w}”`));

/** Which figure counts as revenue, when classes count, and how sales find their line. */
export function revenueExplained(settings: RevenueSettings): string[] {
  const out = [
    `Revenue is ${FIGURE_WORDS[settings.figure].lower}: ${FIGURE_WORDS[settings.figure].detail}. Cancelled and test orders never count.`,
    settings.by_class_date
      ? "A class counts in the month it runs, not the month it was bought."
      : "A class counts in the month it was bought.",
  ];
  if (!hasLines(settings)) {
    out.push("There are no business lines yet, so every sale counts as one business.");
    return out;
  }
  const name = (id: string) => settings.lines.find((l) => l.id === id)?.name ?? "a removed line";
  out.push(
    `Sales are sorted into ${settings.lines.length} lines: ${someNames(
      settings.lines.map((l) => l.name),
      6,
    )}.`,
  );
  for (const rule of settings.rules.slice(0, 8)) {
    const what = MATCH_WORDS[rule.match].needsWords
      ? `${MATCH_WORDS[rule.match].label.toLowerCase()} ${quoted(rule.words)}`
      : MATCH_WORDS[rule.match].label.toLowerCase();
    out.push(`If ${what}, it goes to ${name(rule.line)}.`);
  }
  if (settings.rules.length > 8) out.push(`…and ${settings.rules.length - 8} more rules.`);
  out.push(
    `Rules are checked from the top and the first that matches decides. Anything no rule matches goes to ${name(settings.default_line ?? "")}.`,
  );
  return out;
}

/**
 * How the books' revenue joins the shop's, and why nothing counts twice.
 * Shown beside revenue, profit by line and the invoice list.
 */
export function booksRevenueExplained(settings: RevenueSettings): string[] {
  const books = settings.books;
  const name = (id: string) => settings.lines.find((l) => l.id === id)?.name ?? "a removed line";
  if (!books.invoices && !books.other_income) {
    return [
      "Only sales from your shop count as revenue here. Invoices and other income in your books aren't added.",
    ];
  }
  const out: string[] = [];
  if (books.invoices) {
    const toLines = books.accounts.filter((a) => "line" in a.choice);
    const shop = books.accounts.filter((a) => "skip" in a.choice && a.choice.skip === "shop");
    out.push(
      "Paid invoices from your books are added, before tax, in the month of the invoice's date.",
    );
    if (toLines.length) {
      out.push(
        `Each invoice line goes to the business line its income account is pointed at: ${someNames(
          toLines.map((a) => ("line" in a.choice ? `${a.name} → ${name(a.choice.line)}` : a.name)),
          5,
        )}.`,
      );
    }
    out.push(
      shop.length
        ? `${someNames(
            shop.map((a) => a.name),
            4,
          )} ${shop.length === 1 ? "holds" : "hold"} your shop's own sales, so ${shop.length === 1 ? "it's" : "they're"} left out: those sales already count from the shop.`
        : "An account that holds your shop's own sales should be marked that way, so those sales aren't counted twice.",
      "An invoice on an account you haven't chosen for yet counts nowhere until you do; it's shown apart.",
    );
  }
  if (books.other_income) {
    out.push(
      books.other_income_line
        ? `Your books' other income (interest, one-off income) is added to ${name(books.other_income_line)}. It never holds shop sales.`
        : "Your books' other income (interest, one-off income) is shown as other revenue beside your lines. It never holds shop sales.",
    );
  }
  return out;
}

/** What the invoice list shows and how its standing is decided. */
export function invoicesExplained(settings: RevenueSettings): string[] {
  return [
    "Invoices are read from your books every few hours, from three Januaries back. Nothing is ever changed there.",
    "An invoice is paid when nothing is owed on it, overdue once its due day has gone by (in your workspace's time zone), and open otherwise.",
    ...(hasLines(settings)
      ? [
          "Filtering by a business line shows invoices with at least one line on an income account pointed at it.",
        ]
      : []),
    ...booksRevenueExplained(settings),
  ];
}

/** Which of the books' accounts feed one line's expenses, by the account choices. */
export function lineExpensesExplained(
  sorting: Pick<ExpenseSorting, "accounts">,
  lineId: string,
  lineName: string,
): string[] {
  const whole: string[] = [];
  const part: string[] = [];
  for (const choice of sorting.accounts) {
    if (choice.action.sort === "line" && choice.action.line === lineId) whole.push(choice.name);
    if (choice.action.sort === "split" && choice.action.split[lineId]) {
      part.push(`${choice.name} (${choice.action.split[lineId]}%)`);
    }
  }
  if (whole.length === 0 && part.length === 0) {
    return [
      `No account in your books is pointed at ${lineName} yet, so its own expenses are only what you or your rules sorted there one by one.`,
    ];
  }
  return [
    ...(whole.length ? [`${lineName} takes everything in ${someNames(whole, 5)}.`] : []),
    ...(part.length ? [`It takes a share of ${someNames(part, 5)}.`] : []),
    "Your own choice on a single expense, and your payee defaults and rules, come first.",
  ];
}

/** How a line's profit is put together. */
export function profitExplained(
  settings: ProfitSettings,
  lineName: (id: string) => string,
): string[] {
  const split = Object.entries(settings.shared_split);
  return [
    "Each line's profit is its revenue, less its cost of goods, its own expenses, its share of shared expenses and its share of your monthly costs.",
    settings.cost_of_goods === "shop_item_costs"
      ? "Cost of goods comes from the item costs in your shop, where an item has one."
      : "Cost of goods is among the expenses sorted into lines, like any other expense.",
    split.length
      ? `Shared expenses are split ${split.map(([id, pct]) => `${pct}% ${lineName(id)}`).join(", ")}.`
      : "Shared expenses aren't split between lines yet, so they're shown apart.",
    settings.monthly_costs.length
      ? `${settings.monthly_costs.length} monthly ${settings.monthly_costs.length === 1 ? "cost" : "costs"} your books don't hold ${settings.monthly_costs.length === 1 ? "is" : "are"} shared in by the day.`
      : "No monthly costs outside your books are added.",
  ];
}

/** Why one of the books' liabilities is, or isn't, counted as a debt. */
export function liabilityExplained(input: {
  typeWords: string;
  /** "debt" a person counted it, "not_debt" a person left it out, null the setting decides. */
  choice: "debt" | "not_debt" | null;
  /** Whether the workspace's setting counts this kind of account by itself. */
  byRule: boolean;
}): string {
  if (input.choice === "not_debt") {
    return `You said this isn't a debt. That sticks, even after the next sync.`;
  }
  if (input.choice === "debt") {
    return `You counted this as a debt yourself. QuickBooks lists it as ${input.typeWords}.`;
  }
  return input.byRule
    ? `QuickBooks lists this as ${input.typeWords}, and your setting counts that kind of account as a debt.`
    : `QuickBooks lists this as ${input.typeWords}, which your setting doesn't count as a debt by itself.`;
}

/** Why an expense is sorted the way it is. */
export function expenseSortExplained(
  sortedBy: "person" | "rule" | "vendor" | "account" | "ai" | null,
  action: SortAction | null,
  lineName: (id: string) => string,
): string {
  if (!action) {
    return "Nothing has sorted this yet: its account is set to “decide each one”, so it waits for you.";
  }
  const where = actionWords(action, lineName);
  switch (sortedBy) {
    case "person":
      return `You sorted this one yourself (${where}). Nothing changes it after that.`;
    case "rule":
      return `One of your rules sorted it: ${where}.`;
    case "vendor":
      return `Your default for this payee sorted it: ${where}.`;
    case "account":
      return `Its account in your books is set to ${where.toLowerCase()}, so every expense in it goes the same way.`;
    case "ai":
      return `Claude suggested this and a person said yes: ${where}.`;
    default:
      return `Its account has no choice yet, so it counts as shared across your lines.`;
  }
}

/** Which order the plan follows, and why. */
export function orderExplained(input: {
  from: "recommended" | "person";
  strategy: Strategy;
  recommendation: Recommendation | null;
  money: (cents: number) => string;
}): string[] {
  const label = STRATEGY_META[input.strategy].label;
  const tagline = STRATEGY_META[input.strategy].tagline.toLowerCase();
  if (input.from === "person") {
    return [
      `You chose ${label.toLowerCase()} (${tagline}), so the plan follows it until you change it.`,
      ...(input.recommendation && input.recommendation.strategy !== input.strategy
        ? [
            `The order that pays the least interest right now is ${STRATEGY_META[input.recommendation.strategy].label.toLowerCase()}.`,
          ]
        : []),
    ];
  }
  if (!input.recommendation) {
    return ["With nothing owing at a rate, there's no order to choose yet."];
  }
  return [
    `The plan follows the order that pays the least interest, worked out again each time: now ${label.toLowerCase()} (${tagline}).`,
    recommendationWords(input.recommendation, input.money),
    "Choose another order and the plan keeps to yours.",
  ];
}

/** How the 3-year projection is put together, in the workspace's own rates. */
export function projectionExplained(
  settings: ProjectionSettings,
  lines: readonly { id: string; name: string }[],
): string[] {
  const rate = (pct: number) => `${pct >= 0 ? "grows" : "shrinks"} ${Math.abs(pct)}% a year`;
  return [
    "It starts from your books' last twelve complete months: their revenue, cost of goods and running costs.",
    lines.length
      ? "Revenue is shared among your lines as your shop (and your books, where you count them) split it over the same months."
      : "With no business lines yet, revenue is one figure.",
    ...lines.map((l) => `${l.name} ${rate(settings.line_growth[l.id] ?? settings.other_growth)}.`),
    `Cost of goods ${rate(settings.cogs_growth)}; running costs ${rate(settings.fixed_growth)}.`,
    "Each year grows from the one before, in whole cents. It's a sketch, not a forecast: nothing about the year ahead is known to it.",
  ];
}
