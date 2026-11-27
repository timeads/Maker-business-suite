import { hasLines, type RevenueSettings } from "./lines";
import { sameName } from "./expenses";
import type { ProfitSettings } from "./profit";
import { someNames, type SetupItem, type SetupStep } from "../setup/items";

/**
 * "Finish setting up Money": what still stands between the workspace and
 * figures it can trust, worked out on read from what it already has. Pure:
 * the facts are loaded in `setup-data.ts` and nothing here is stored (a
 * person's "Not now" is kept by `lib/setup`). Only what makes the figures
 * truer is raised; optional things (cash health thresholds, the layout) are
 * fine as they are and never nag.
 *
 * Debt items are made only from `debts`, which is loaded for owners and
 * admins alone: for anyone else there are none, as everywhere.
 */

export const MONEY_TOOL = "money";

export const MONEY_STEPS: readonly SetupStep[] = [
  { id: "read", title: "What we read from your books and shop" },
  { id: "lines", title: "Your business lines" },
  { id: "debts", title: "Your debts", managersOnly: true },
  { id: "fund", title: "Your emergency fund", managersOnly: true },
  { id: "expenses", title: "How you'd like expenses sorted" },
  { id: "review", title: "Have a look" },
];

/** A connection as the checklist sees it; null when there is none. */
export type ConnectionFact = {
  status: "active" | "needs_reconnect" | "disconnected";
  lastSyncedAt: string | null;
  lastError: string | null;
};

export type NamedRef = { id: string; name: string };

export type MoneyDebtFacts = {
  /** Debts the plan pays (not paid off, not covered by a plan). */
  count: number;
  /** Owing something with no rate given. */
  needsRate: NamedRef[];
  /** Owing something with neither a minimum nor a payment (a share of sales has its own). */
  noPayment: NamedRef[];
  /** "Also in your books" items nobody has decided on yet (not counted, not hidden, not "not a debt"). */
  unlooked: NamedRef[];
  /** Accounts that look like one company paying several debts (`passThroughAccounts`). */
  passThrough: (NamedRef & { pays: NamedRef[] })[];
  /** The fund's accounts are chosen (or what's in it was typed in). */
  fundChosen: boolean;
  /** The debt setting was ever saved (an order was looked at), or a person chose one. */
  orderLooked: boolean;
};

export type MoneySetupFacts = {
  now: Date;
  books: ConnectionFact | null;
  shop: ConnectionFact | null;
  revenue: RevenueSettings;
  profit: ProfitSettings;
  /** Recent orders, and how many fell to the default line; only where counted. */
  defaultShare?: { orders: number; toDefault: number } | null;
  /** The books' expense accounts, and how many still have no choice (shared by default). */
  accounts?: { total: number; automatic: number } | null;
  /** Invoices not in a line yet (by their own choice, customer or account); only when invoices count. */
  invoicesWaiting?: number | null;
  /** Budget rows typed in; null when not known. */
  budgetRows?: number | null;
  /** Recurring charges nobody has decided on; only where counted. */
  cutterWaiting?: number | null;
  /** Owners and admins only. */
  debts?: MoneyDebtFacts | null;
};

/** Hours after which a connection's last read counts as old. */
export const OLD_AFTER_HOURS = 72;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const ids = (refs: readonly NamedRef[]) =>
  refs
    .map((r) => r.id)
    .sort()
    .join(",");

function connectionItems(
  key: "books" | "shop",
  fact: ConnectionFact | null,
  now: Date,
): SetupItem[] {
  const name = key === "books" ? "QuickBooks" : "your shop";
  const Name = key === "books" ? "QuickBooks" : "Your shop";
  const what =
    key === "books"
      ? "Cash, profit, expenses and debts come from your books."
      : "Sales, best sellers and business lines come from your shop.";
  if (!fact || fact.status === "disconnected") {
    return [
      {
        id: `${key}.connect`,
        title: key === "books" ? "Connect your books" : "Connect your shop",
        why: what,
        to: "connections",
        action: `Connect ${name}`,
        facts: "none",
        step: "read",
      },
    ];
  }
  if (fact.status === "needs_reconnect") {
    return [
      {
        id: `${key}.reconnect`,
        title: `${Name} needs reconnecting`,
        why: `${what} Until it's reconnected they stop at the last read.`,
        to: "connections",
        action: `Reconnect ${name}`,
        facts: fact.lastSyncedAt ?? "never",
        step: "read",
      },
    ];
  }
  if (fact.lastError) {
    return [
      {
        id: `${key}.failed`,
        title: `The last read of ${name} didn't finish`,
        why: "The figures are from the read before it. Reading again usually sorts it out.",
        to: "dashboard/setup#read",
        action: "Read again",
        facts: `${fact.lastSyncedAt ?? "never"}`,
        step: "read",
      },
    ];
  }
  const last = fact.lastSyncedAt ? new Date(fact.lastSyncedAt).getTime() : null;
  if (last === null || now.getTime() - last > OLD_AFTER_HOURS * 3600_000) {
    return [
      {
        id: `${key}.old`,
        title: last === null ? `${Name} hasn't been read yet` : `${Name} hasn't been read lately`,
        why: "The figures are only as fresh as the last read.",
        to: "dashboard/setup#read",
        action: "Read again",
        facts: fact.lastSyncedAt ?? "never",
        step: "read",
      },
    ];
  }
  return [];
}

/** The open items, in the order the guided setup takes them. */
export function moneySetupItems(facts: MoneySetupFacts): SetupItem[] {
  const items: SetupItem[] = [
    ...connectionItems("books", facts.books, facts.now),
    ...connectionItems("shop", facts.shop, facts.now),
  ];
  const lines = hasLines(facts.revenue);
  const shopOn = facts.shop !== null && facts.shop.status !== "disconnected";

  if (shopOn && !lines) {
    items.push({
      id: "lines.none",
      title: "Sort your sales into business lines",
      why: "Right now every sale counts as one business, so Money can't say which part of it earns the most.",
      to: "dashboard/setup#lines",
      action: "Choose your lines",
      facts: "none",
      step: "lines",
    });
  }
  const share = facts.defaultShare;
  if (lines && share && share.orders >= 10 && share.toDefault / share.orders >= 0.25) {
    const pct = Math.round((share.toDefault / share.orders) * 100);
    const name =
      facts.revenue.lines.find((l) => l.id === facts.revenue.default_line)?.name ??
      "the default line";
    items.push({
      id: "lines.default",
      title: `${pct}% of recent orders fall to ${name}`,
      why: "No rule matched them, so they land on the line for everything else. A rule or two more would place them.",
      count: share.toDefault,
      to: "settings/money/lines#rules",
      action: "Add a rule",
      facts: `${Math.floor(pct / 10)}`,
      step: "lines",
    });
  }

  const debts = facts.debts;
  if (debts) {
    if (debts.needsRate.length > 0) {
      const one = debts.needsRate.length === 1 ? debts.needsRate[0] : null;
      items.push({
        id: "debt.rates",
        title: `Add the rate to ${plural(debts.needsRate.length, "debt")}`,
        why: "QuickBooks doesn't keep interest rates, so the plan counts these at 0% until you add them.",
        count: debts.needsRate.length,
        names: debts.needsRate.map((d) => d.name),
        to: one ? `dashboard/debts/accounts#debt-${one.id}` : "dashboard/setup#debts",
        action: one ? "Add the rate" : "Add the rates",
        facts: ids(debts.needsRate),
        step: "debts",
      });
    }
    if (debts.noPayment.length > 0) {
      const one = debts.noPayment.length === 1 ? debts.noPayment[0] : null;
      items.push({
        id: "debt.payments",
        title: `Add the monthly payment to ${plural(debts.noPayment.length, "debt")}`,
        why: "Without a minimum or a usual payment, the plan can't tell when these will be paid off.",
        count: debts.noPayment.length,
        names: debts.noPayment.map((d) => d.name),
        to: one ? `dashboard/debts/accounts#debt-${one.id}` : "dashboard/setup#debts",
        action: one ? "Add the payment" : "Add the payments",
        facts: ids(debts.noPayment),
        step: "debts",
      });
    }
    if (debts.passThrough.length > 0) {
      items.push({
        id: "debt.pass-through",
        title: "Does one company pay several of these for you?",
        why: `Money moves through ${someNames(debts.passThrough.map((p) => p.name))} into more than one debt. If you pay one company that pays them, make it a plan so nothing is counted twice.`,
        names: debts.passThrough.map((p) => p.name),
        to: "dashboard/setup#plan",
        action: "Make it a plan",
        facts: ids(debts.passThrough),
        step: "debts",
      });
    }
    if (debts.unlooked.length > 0) {
      items.push({
        id: "debt.unlooked",
        title: `Look over ${plural(debts.unlooked.length, "other thing")} your books say you owe`,
        why: "They aren't counted as debts. If one is a loan or a card, count it so the plan pays it down.",
        count: debts.unlooked.length,
        names: debts.unlooked.map((d) => d.name),
        to: "dashboard/debts/accounts#also-in-books",
        action: "Look them over",
        facts: ids(debts.unlooked),
        step: "debts",
      });
    }
    if (debts.count > 0 && !debts.orderLooked) {
      items.push({
        id: "debt.order",
        title: "Have a look at the order your plan pays debts in",
        why: "It follows the order that pays the least interest. That's usually right, but it's your call.",
        to: "dashboard/debts#order",
        action: "See the order",
        facts: "never",
        step: "debts",
      });
    }
    if (!debts.fundChosen && facts.books && facts.books.status !== "disconnected") {
      items.push({
        id: "debt.fund",
        title: "Choose where your emergency fund is kept",
        why: "Tick the bank account it sits in, and the plan keeps an eye on it for you.",
        to: "dashboard/setup#fund",
        action: "Choose the account",
        facts: "none",
        step: "fund",
      });
    }
  }

  // One item for invoices, counted invoice by invoice: choosing for an income
  // account settles every invoice on it at once, and a hand-sorted invoice
  // settles itself, so the count is what's really still waiting.
  const waitingInvoices = facts.invoicesWaiting ?? 0;
  if (lines && facts.revenue.books.invoices && waitingInvoices > 0) {
    items.push({
      id: "revenue.invoices",
      title: `Put ${plural(waitingInvoices, "invoice")} in a business line`,
      why: "They count nowhere until they're in a line. Choosing a line for an income account sorts every invoice on it at once; mark the one that holds your shop's own sales so nothing counts twice.",
      count: waitingInvoices,
      to: "dashboard/invoices?waiting=1",
      action: "Sort them",
      facts: String(waitingInvoices),
      step: "lines",
    });
  }

  const accounts = facts.accounts;
  if (lines && accounts && accounts.automatic > 0) {
    items.push({
      id: "expenses.accounts",
      title: `${plural(accounts.automatic, "expense account")} still shared by default`,
      why: "They're shared across your lines in profit by line. Point the ones that belong to one line at it.",
      count: accounts.automatic,
      to: "dashboard/setup#expenses",
      action: "Sort the biggest",
      facts: String(accounts.automatic),
      step: "expenses",
    });
  }
  if (lines && Object.keys(facts.profit.shared_split).length === 0) {
    items.push({
      id: "profit.split",
      title: "Say how shared costs split between your lines",
      why: "Until you do, rent and other shared costs sit apart, and each line's profit leaves them out.",
      to: "settings/money/profit#split",
      action: "Set the split",
      facts: facts.revenue.lines
        .map((l) => l.id)
        .sort()
        .join(","),
      step: "expenses",
    });
  }

  const booksOn = facts.books !== null && facts.books.status !== "disconnected";
  if (facts.books?.status === "active" && facts.revenue.closed_months === "shop") {
    items.push({
      id: "revenue.closed-months",
      title: "Make your books the final number for months that have ended",
      why: "Your books hold what really came in once a month closes. Your shop's sales still decide how each month splits into your lines.",
      to: "settings/money/lines#closed-months",
      action: "Have a look",
      facts: "shop",
      step: "lines",
      optional: true,
      managersOnly: true,
    });
  }
  if (booksOn && facts.budgetRows === 0) {
    items.push({
      id: "budget.empty",
      title: "Set a budget",
      why: "A budget turns the figures into a plan: what you meant to spend beside what you did.",
      to: "dashboard/budget",
      action: "Start a budget",
      facts: "none",
      step: "review",
    });
  }
  if (facts.cutterWaiting && facts.cutterWaiting > 0) {
    items.push({
      id: "cutter.waiting",
      title: `${plural(facts.cutterWaiting, "regular charge")} waiting for a decision`,
      why: "Decide what's worth keeping; nothing is cancelled for you.",
      count: facts.cutterWaiting,
      to: "dashboard/cost-cutter",
      action: "Go through them",
      facts: String(facts.cutterWaiting),
      step: "review",
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// "Does one company pay several of these for you?"
// ---------------------------------------------------------------------------

/** A payment into a debt, as the books show it (`money_debt_payment_list`, folded). */
export type PaymentFrom = { debtId: string; fromAccount: string | null };

/** How near zero an account must sit to look like money only passing through. */
export const PASS_THROUGH_CENTS = 100;

/**
 * Liability accounts in the books that money only passes through on its way
 * into SEVERAL debts: at (or within a dollar of) zero, and named as where
 * payments into at least two different debts came from. That is what a
 * company paying a few cards or loans for the business looks like in the
 * books. By the books' own account names, never a lender's: the account is
 * the workspace's.
 */
export function passThroughAccounts(
  accounts: readonly { id: string; name: string; balance: number }[],
  payments: readonly PaymentFrom[],
  debts: readonly NamedRef[],
): (NamedRef & { pays: NamedRef[] })[] {
  const debtOf = new Map(debts.map((d) => [d.id, d]));
  const paidFrom = new Map<string, Map<string, NamedRef>>();
  for (const p of payments) {
    if (!p.fromAccount) continue;
    const debt = debtOf.get(p.debtId);
    if (!debt) continue;
    const key = sameName(p.fromAccount);
    const paid = paidFrom.get(key) ?? new Map<string, NamedRef>();
    paid.set(debt.id, debt);
    paidFrom.set(key, paid);
  }
  return accounts
    .filter((a) => Math.abs(a.balance) <= PASS_THROUGH_CENTS)
    .flatMap((a) => {
      const pays = [...(paidFrom.get(sameName(a.name))?.values() ?? [])];
      return pays.length >= 2
        ? [{ id: a.id, name: a.name, pays: pays.sort((x, y) => x.name.localeCompare(y.name)) }]
        : [];
    });
}

// ---------------------------------------------------------------------------
// Business lines to suggest
// ---------------------------------------------------------------------------

/** A possible line, from what the shop's own sales already carry. */
export type LineSuggestion = {
  match: "order_tag" | "product_type" | "workshop";
  /** The tag or type as the shop has it; empty for the Bookings workshops. */
  word: string;
  cents: number;
};

/**
 * Lines worth suggesting, from the revenue the shop's sales already carry:
 * the order tags and product types that bring in the most, and the Bookings
 * workshops sold through the shop. Only words that are there, never one
 * made up; spellings that compare the same (`sameWord` rules) are one.
 */
export function lineSuggestions(
  groups: readonly {
    order_tags: string[] | null;
    product_type: string | null;
    workshop: boolean;
    revenue_cents: number;
  }[],
  limit = 6,
): LineSuggestion[] {
  const fold = (w: string) =>
    w
      .trim()
      .toLowerCase()
      .replace(/[-_\s]+/g, " ");
  const tally = (kind: "order_tag" | "product_type") => {
    const sums = new Map<string, { word: string; cents: number }>();
    return {
      add(word: string, cents: number) {
        const key = fold(word);
        if (!key) return;
        const seen = sums.get(key) ?? { word: word.trim(), cents: 0 };
        seen.cents += cents;
        sums.set(key, seen);
      },
      top: () =>
        [...sums.values()]
          .filter((s) => s.cents > 0)
          .sort((a, b) => b.cents - a.cents || a.word.localeCompare(b.word))
          .slice(0, limit)
          .map((s) => ({ match: kind, word: s.word, cents: s.cents })),
    };
  };
  const tags = tally("order_tag");
  const types = tally("product_type");
  let workshop = 0;
  for (const g of groups) {
    const cents = Math.max(0, g.revenue_cents);
    const once = new Map((g.order_tags ?? []).map((t) => [fold(t), t] as const));
    for (const tag of once.values()) tags.add(tag, cents);
    if (g.product_type) types.add(g.product_type, cents);
    if (g.workshop) workshop += cents;
  }
  return [
    ...(workshop > 0 ? [{ match: "workshop" as const, word: "", cents: workshop }] : []),
    ...types.top(),
    ...tags.top(),
  ];
}
