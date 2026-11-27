import { describe, expect, it } from "vitest";
import { DEFAULT_REVENUE_SETTINGS, type RevenueSettings } from "./lines";
import { DEFAULT_PROFIT_SETTINGS } from "./profit";
import {
  MONEY_STEPS,
  moneySetupItems,
  lineSuggestions,
  passThroughAccounts,
  type MoneyDebtFacts,
  type MoneySetupFacts,
} from "./setup";
import { firstOpenStep } from "../setup/items";

const NOW = new Date("2026-11-26T15:00:00Z");
const fresh = { status: "active" as const, lastSyncedAt: "2026-11-26T09:00:00Z", lastError: null };
const LINES: RevenueSettings = {
  ...DEFAULT_REVENUE_SETTINGS,
  closed_months: "books",
  lines: [
    { id: "shop", name: "Shop" },
    { id: "classes", name: "Classes" },
  ],
  default_line: "shop",
};
const NO_DEBT_WORK: MoneyDebtFacts = {
  count: 2,
  needsRate: [],
  noPayment: [],
  unlooked: [],
  passThrough: [],
  fundChosen: true,
  orderLooked: true,
};
const base = (more: Partial<MoneySetupFacts> = {}): MoneySetupFacts => ({
  now: NOW,
  books: fresh,
  shop: fresh,
  revenue: LINES,
  profit: { ...DEFAULT_PROFIT_SETTINGS, shared_split: { shop: 60, classes: 40 } },
  accounts: { total: 20, automatic: 0 },
  budgetRows: 12,
  ...more,
});
const idsOf = (facts: MoneySetupFacts) => moneySetupItems(facts).map((i) => i.id);

describe("moneySetupItems", () => {
  it("has nothing to say about a workspace that's set up", () => {
    expect(moneySetupItems(base({ debts: NO_DEBT_WORK }))).toEqual([]);
  });

  it("asks about invoice accounts only once invoices count, and only those waiting", () => {
    const counting = { ...LINES, books: { ...LINES.books, invoices: true } };
    expect(idsOf(base({ invoiceAccountsWaiting: 3 }))).toEqual([]);
    expect(idsOf(base({ revenue: counting, invoiceAccountsWaiting: 0 }))).toEqual([]);
    const [item] = moneySetupItems(base({ revenue: counting, invoiceAccountsWaiting: 2 }));
    expect(item).toMatchObject({
      id: "revenue.invoice-accounts",
      title: "Say which line 2 income accounts' invoices go to",
      to: "settings/money/lines#books",
      step: "lines",
      facts: "2",
    });
  });

  it("offers the books as the final number, optionally, once QuickBooks is connected", () => {
    const shop = { ...LINES, closed_months: "shop" as const };
    const [item] = moneySetupItems(base({ revenue: shop }));
    expect(item).toMatchObject({
      id: "revenue.closed-months",
      to: "settings/money/lines#closed-months",
      optional: true,
      managersOnly: true,
    });
    expect(idsOf(base({ revenue: shop, books: null }))).not.toContain("revenue.closed-months");
    expect(
      idsOf(base({ revenue: shop, books: { ...fresh, status: "needs_reconnect" } })),
    ).not.toContain("revenue.closed-months");
  });

  it("asks for the connections first, and only what's missing", () => {
    expect(idsOf(base({ books: null }))).toEqual(["books.connect"]);
    expect(
      idsOf(base({ books: { ...fresh, status: "needs_reconnect" }, shop: null })).slice(0, 2),
    ).toEqual(["books.reconnect", "shop.connect"]);
    expect(idsOf(base({ books: { ...fresh, lastError: "boom" } }))).toEqual(["books.failed"]);
    expect(idsOf(base({ shop: { ...fresh, lastSyncedAt: "2026-11-20T09:00:00Z" } }))).toEqual([
      "shop.old",
    ]);
    expect(idsOf(base({ shop: { ...fresh, lastSyncedAt: null } }))).toEqual(["shop.old"]);
  });

  it("asks for business lines once a shop is connected, and the split and accounts only after", () => {
    const none = base({
      revenue: { ...DEFAULT_REVENUE_SETTINGS, closed_months: "books" },
      profit: DEFAULT_PROFIT_SETTINGS,
      accounts: { total: 20, automatic: 20 },
    });
    // Profit by line and the accounts only matter once there are lines.
    expect(idsOf(none)).toEqual(["lines.none"]);
    expect(idsOf({ ...none, shop: null })).toEqual(["shop.connect"]);
    expect(
      idsOf(base({ profit: DEFAULT_PROFIT_SETTINGS, accounts: { total: 20, automatic: 7 } })),
    ).toEqual(["expenses.accounts", "profit.split"]);
    const accounts = moneySetupItems(base({ accounts: { total: 20, automatic: 7 } }))[0];
    expect(accounts.title).toBe("7 expense accounts still shared by default");
    expect(accounts.count).toBe(7);
  });

  it("names the share of recent orders falling to the default line, when it's a lot", () => {
    expect(idsOf(base({ defaultShare: { orders: 100, toDefault: 10 } }))).toEqual([]);
    expect(idsOf(base({ defaultShare: { orders: 4, toDefault: 4 } }))).toEqual([]);
    const [item] = moneySetupItems(base({ defaultShare: { orders: 100, toDefault: 42 } }));
    expect(item.title).toBe("42% of recent orders fall to Shop");
    expect(item.to).toBe("settings/money/lines#rules");
  });

  it("raises the debts' gaps, linking straight to the one debt where there's one", () => {
    const debts: MoneyDebtFacts = {
      ...NO_DEBT_WORK,
      needsRate: [{ id: "d1", name: "Card A" }],
      noPayment: [
        { id: "d2", name: "Loan B" },
        { id: "d3", name: "Card C" },
      ],
      unlooked: [{ id: "a1", name: "Tax owed" }],
      fundChosen: false,
      orderLooked: false,
    };
    const items = moneySetupItems(base({ debts }));
    expect(items.map((i) => i.id)).toEqual([
      "debt.rates",
      "debt.payments",
      "debt.unlooked",
      "debt.order",
      "debt.fund",
    ]);
    expect(items[0]).toMatchObject({
      title: "Add the rate to 1 debt",
      to: "dashboard/debts/accounts#debt-d1",
      names: ["Card A"],
    });
    expect(items[1]).toMatchObject({ title: "Add the monthly payment to 2 debts", count: 2 });
    expect(items[1].to).toBe("dashboard/setup#debts");
    // The facts are ids only: a new debt needing a rate brings the item back.
    expect(items[0].facts).toBe("d1");
    expect(items[1].facts).toBe("d2,d3");
  });

  it("never raises a debt item without the debt facts (anyone but owners and admins)", () => {
    expect(idsOf(base({ debts: null })).filter((id) => id.startsWith("debt"))).toEqual([]);
  });

  it("doesn't nag about a budget or the cost cutter it doesn't know about", () => {
    expect(idsOf(base({ budgetRows: null, cutterWaiting: null }))).toEqual([]);
    expect(idsOf(base({ budgetRows: 0, cutterWaiting: 3 }))).toEqual([
      "budget.empty",
      "cutter.waiting",
    ]);
    expect(idsOf(base({ budgetRows: 0, books: null }))).toEqual(["books.connect"]);
  });

  it("keeps every item on one of the steps, debts on the owners' ones", () => {
    const debts: MoneyDebtFacts = {
      ...NO_DEBT_WORK,
      needsRate: [{ id: "d1", name: "A" }],
      fundChosen: false,
    };
    const items = moneySetupItems(
      base({ debts, budgetRows: 0, books: { ...fresh, lastError: "x" } }),
    );
    const steps = new Map(MONEY_STEPS.map((s) => [s.id, s]));
    for (const item of items) {
      expect(steps.has(item.step), item.id).toBe(true);
      if (item.id.startsWith("debt")) expect(steps.get(item.step)?.managersOnly).toBe(true);
    }
    expect(firstOpenStep(MONEY_STEPS, items)).toBe("read");
  });
});

describe("passThroughAccounts", () => {
  const debts = [
    { id: "c1", name: "Card One" },
    { id: "c2", name: "Card Two" },
    { id: "l1", name: "Loan" },
  ];
  it("finds an account at zero that payments into several debts came from", () => {
    const found = passThroughAccounts(
      [
        { id: "p", name: "Pay Plan", balance: 0 },
        { id: "q", name: "Savings Loan", balance: 500000 },
      ],
      [
        { debtId: "c1", fromAccount: "pay  plan" },
        { debtId: "c2", fromAccount: "Pay Plan" },
        { debtId: "c2", fromAccount: "Pay Plan" },
        { debtId: "l1", fromAccount: "Savings Loan" },
        { debtId: "c1", fromAccount: "Savings Loan" },
      ],
      debts,
    );
    expect(found).toEqual([
      {
        id: "p",
        name: "Pay Plan",
        pays: [
          { id: "c1", name: "Card One" },
          { id: "c2", name: "Card Two" },
        ],
      },
    ]);
  });

  it("needs two different debts, and an account that isn't holding a balance", () => {
    expect(
      passThroughAccounts(
        [{ id: "p", name: "Pay Plan", balance: 99 }],
        [
          { debtId: "c1", fromAccount: "Pay Plan" },
          { debtId: "c1", fromAccount: "Pay Plan" },
        ],
        debts,
      ),
    ).toEqual([]);
    expect(
      passThroughAccounts(
        [{ id: "p", name: "Pay Plan", balance: 101 }],
        [
          { debtId: "c1", fromAccount: "Pay Plan" },
          { debtId: "c2", fromAccount: "Pay Plan" },
        ],
        debts,
      ),
    ).toEqual([]);
    expect(
      passThroughAccounts(
        [{ id: "p", name: "Pay Plan", balance: -50 }],
        [
          { debtId: "c1", fromAccount: "Pay Plan" },
          { debtId: "zz", fromAccount: "Pay Plan" },
          { debtId: "c2", fromAccount: null },
        ],
        debts,
      ),
    ).toEqual([]);
  });
});

describe("lineSuggestions", () => {
  it("suggests the workshops, then product types and order tags by what they bring in", () => {
    const found = lineSuggestions([
      { order_tags: ["wholesale"], product_type: "Rug", workshop: false, revenue_cents: 90000 },
      {
        order_tags: ["Wholesale", "wholesale"],
        product_type: "rug",
        workshop: false,
        revenue_cents: 10000,
      },
      { order_tags: null, product_type: "Yarn", workshop: false, revenue_cents: 20000 },
      { order_tags: null, product_type: null, workshop: true, revenue_cents: 50000 },
      { order_tags: ["  "], product_type: "Refunded", workshop: false, revenue_cents: -500 },
    ]);
    expect(found).toEqual([
      { match: "workshop", word: "", cents: 50000 },
      { match: "product_type", word: "Rug", cents: 100000 },
      { match: "product_type", word: "Yarn", cents: 20000 },
      { match: "order_tag", word: "wholesale", cents: 100000 },
    ]);
  });

  it("suggests nothing it can't see", () => {
    expect(lineSuggestions([])).toEqual([]);
  });
});
