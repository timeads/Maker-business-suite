import { describe, expect, it } from "vitest";
import { debtPlan } from "./engine";
import { debtBudgetRows, debtHomeLine, debtTotals, toPlanDebt, type Debt } from "./figures";
import {
  coverWords,
  debtPlanFieldsSchema,
  foldDebts,
  foldPayments,
  shownAccountIds,
  type FoldAccount,
} from "./plans";

/** Made-up debts and accounts: nothing here is a real lender, bank or account. */
const debt = (over: Partial<Debt> & Pick<Debt, "id">): Debt => ({
  name: over.id,
  kind: "card",
  plan: "pool",
  status: "active",
  rateBp: 2000,
  minimum: 2500,
  payment: null,
  revolvingBp: null,
  dueDay: null,
  priority: null,
  opening: null,
  booksAccount: null,
  source: "books",
  bookAccountId: null,
  needsRate: false,
  note: null,
  balance: null,
  balanceAsOf: null,
  balanceFrom: null,
  consolidated: false,
  coveredBy: null,
  planAccountId: null,
  planBalanceFrom: null,
  credit: 0,
  ...over,
});

const plan = (over: Partial<Debt> = {}) =>
  debt({
    id: "plan",
    name: "Card plan",
    kind: "other",
    plan: "fixed",
    source: "person",
    rateBp: 0,
    minimum: 0,
    payment: 40000,
    consolidated: true,
    planBalanceFrom: "covered",
    ...over,
  });

const cardA = debt({
  id: "a",
  name: "Card A",
  balance: 120000,
  balanceAsOf: "2026-11-20",
  balanceFrom: "books",
  opening: 200000,
  coveredBy: "plan",
  bookAccountId: "acc-a",
});
const cardB = debt({
  id: "b",
  name: "Card B",
  balance: 80001,
  balanceAsOf: "2026-11-24",
  balanceFrom: "books",
  coveredBy: "plan",
  bookAccountId: "acc-b",
});
const own = debt({ id: "own", name: "Van loan", balance: 500000, rateBp: 700, minimum: 15000 });

describe("folding covered debts into their plan", () => {
  it("leaves one debt for everything else to count, its balance the covered ones added up", () => {
    const fold = foldDebts([plan(), cardA, cardB, own]);
    expect(fold.debts.map((d) => d.id)).toEqual(["plan", "own"]);
    const folded = fold.debts[0];
    expect(folded).toMatchObject({
      balance: 200001,
      balanceAsOf: "2026-11-24",
      balanceFrom: "books",
      plan: "fixed",
      // Started-at follows the covered debts that gave one.
      opening: 200000,
    });
    expect(folded.group).toMatchObject({ coveredSum: 200001, differs: false, gone: [] });
    expect(folded.group?.covers.map((d) => d.id)).toEqual(["a", "b"]);
    expect([...fold.into]).toEqual([
      ["a", "plan"],
      ["b", "plan"],
    ]);
  });

  it("keeps each covered debt exactly as it was: its own rate and minimum, unused", () => {
    const fold = foldDebts([plan(), cardA, cardB]);
    expect(fold.debts[0].group?.covers[0]).toBe(cardA);
    // Not covered any more: back as itself, nothing changed.
    const back = foldDebts([plan(), { ...cardA, coveredBy: null }, cardB]);
    expect(back.debts.find((d) => d.id === "a")).toEqual({ ...cardA, coveredBy: null });
  });

  it("hands the engine one fixed payment, so the cards never count on their own", () => {
    const fold = foldDebts([plan(), cardA, cardB, own]);
    const input = {
      debts: fold.debts.map(toPlanDebt),
      start: "2026-11",
      averageRevenue: 0,
      revenueSharePct: 10,
      emergency: { target: 0, current: 0, splitPct: 0, monthly: 0 },
      overrides: new Map(),
      strategy: "avalanche" as const,
    };
    const result = debtPlan(input);
    expect(input.debts.map((d) => [d.id, d.plan, d.balance, d.payment])).toEqual([
      ["plan", "fixed", 200001, 40000],
      ["own", "pool", 500000, null],
    ]);
    // Only the plan is paid at its fixed payment; the cards aren't in the plan at all.
    expect(Object.keys(result.plan[0].balances).sort()).toEqual(["own", "plan"]);
    expect(result.plan[0].balances.plan).toBe(200001 - 40000);
    expect(result.poolDebts.map((d) => d.id)).toEqual(["own"]);
    // Totals, the budget and the home card see the plan, once.
    expect(debtTotals(fold.debts)).toEqual({ owed: 700001, paidOff: 0, monthly: 55000 });
    const rows = debtBudgetRows({
      debts: fold.debts,
      paid: [],
      months: ["2026-11"],
      current: "2026-11",
      warnPct: 10,
    });
    expect(rows.map((r) => r.name)).toEqual(["Card plan", "Van loan"]);
    expect(debtHomeLine(fold.debts, (c) => `$${c / 100}`)).toContain("$7000.01 of debt to go");
  });

  it("drops a covered debt gone from the books out of the sum, and says so", () => {
    const fold = foldDebts([plan(), cardA, { ...cardB, status: "closed" }]);
    expect(fold.debts[0].balance).toBe(120000);
    expect(fold.debts[0].group?.gone.map((d) => d.name)).toEqual(["Card B"]);
    expect(fold.debts[0].group?.covers.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("has no balance yet while it covers nothing with a balance", () => {
    expect(foldDebts([plan()]).debts[0]).toMatchObject({ balance: null, balanceFrom: null });
    expect(
      foldDebts([plan(), { ...cardA, balance: null, balanceAsOf: null }]).debts[0].balance,
    ).toBeNull();
  });

  it("takes a typed balance as given, and quietly notes when the cards add up differently", () => {
    const typed = plan({
      planBalanceFrom: "typed",
      balance: 195000,
      balanceAsOf: "2026-11-01",
      balanceFrom: "person",
    });
    const folded = foldDebts([typed, cardA, cardB]).debts[0];
    expect(folded).toMatchObject({ balance: 195000, balanceFrom: "person" });
    expect(folded.group).toMatchObject({ coveredSum: 200001, differs: true });
    // The same figure: nothing to say.
    const same = foldDebts([{ ...typed, balance: 200001 }, cardA, cardB]).debts[0];
    expect(same.group?.differs).toBe(false);
  });

  it("reads its balance from its own account in the books, nothing below zero", () => {
    const accounts: FoldAccount[] = [
      { id: "acc-plan", name: "Plan loan", balance: 210000, asOf: "2026-11-24", gone: false },
    ];
    const onBooks = plan({ planBalanceFrom: "account", planAccountId: "acc-plan" });
    const folded = foldDebts([onBooks, cardA, cardB], accounts).debts[0];
    expect(folded).toMatchObject({ balance: 210000, balanceFrom: "books" });
    expect(folded.group).toMatchObject({
      account: { id: "acc-plan", name: "Plan loan" },
      differs: true,
    });
    const credit = foldDebts([onBooks], [{ ...accounts[0], balance: -500 }]).debts[0];
    expect(credit.balance).toBe(0);
    const gone = foldDebts([onBooks], [{ ...accounts[0], gone: true }]).debts[0];
    expect(gone.balance).toBeNull();
  });

  it("folds the plan's own account in, so it never counts as a debt by itself", () => {
    const passThrough = debt({
      id: "pass",
      name: "Plan company",
      balance: 0,
      bookAccountId: "acc-plan",
    });
    const fold = foldDebts([plan({ planAccountId: "acc-plan" }), cardA, passThrough]);
    expect(fold.debts.map((d) => d.id)).toEqual(["plan"]);
    expect(fold.debts[0].group?.accountDebt?.id).toBe("pass");
    expect(fold.into.get("pass")).toBe("plan");
    expect(shownAccountIds(fold.debts)).toEqual(new Set(["acc-plan", "acc-a"]));
  });

  it("leaves debts pointing at no plan here as they are", () => {
    const fold = foldDebts([{ ...cardA, coveredBy: "elsewhere" }]);
    expect(fold.debts.map((d) => d.id)).toEqual(["a"]);
  });
});

describe("payments into a plan", () => {
  const rows = [
    { debtId: "a", month: "2026-10", cents: 20000 },
    { debtId: "b", month: "2026-10", cents: 20000 },
    { debtId: "own", month: "2026-10", cents: 15000 },
  ];

  it("are the covered debts' payments added up, when the plan has no account of its own", () => {
    const fold = foldDebts([plan(), cardA, cardB, own]);
    expect(foldPayments(rows, fold)).toEqual([
      { debtId: "plan", month: "2026-10", cents: 20000 },
      { debtId: "plan", month: "2026-10", cents: 20000 },
      { debtId: "own", month: "2026-10", cents: 15000 },
    ]);
    // The budget's row for the plan adds those up for the month.
    const budget = debtBudgetRows({
      debts: fold.debts,
      paid: foldPayments(rows, fold),
      months: ["2026-10"],
      current: "2026-11",
      warnPct: 10,
    });
    expect(budget.find((r) => r.name === "Card plan")?.actual).toBe(40000);
  });

  it("are only the moves into its own account, when it has one", () => {
    const fold = foldDebts([plan({ planAccountId: "acc-plan" }), cardA, cardB, own]);
    const mine = [...rows, { debtId: "plan", month: "2026-10", cents: 40000 }];
    expect(foldPayments(mine, fold)).toEqual([
      { debtId: "own", month: "2026-10", cents: 15000 },
      { debtId: "plan", month: "2026-10", cents: 40000 },
    ]);
  });
});

describe("a plan's row in words", () => {
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  it("says how many it covers and what their books balances add up to", () => {
    const group = foldDebts([plan(), cardA, cardB]).debts[0].group!;
    expect(coverWords(group, money)).toBe(
      "Covers 2 cards · their books balances add up to $2000.01",
    );
    expect(coverWords(foldDebts([plan()]).debts[0].group!, money)).toBe(
      "Doesn't pay any debts yet",
    );
    const mixed = foldDebts([plan(), cardA, { ...own, coveredBy: "plan", kind: "loan" }]).debts[0]
      .group!;
    expect(coverWords(mixed, money)).toMatch(/^Covers 2 debts/);
  });
});

describe("a plan's details as saved", () => {
  const fields = {
    name: "Card plan",
    status: "active",
    rate_bp: 0,
    payment_cents: 40000,
    due_day: 3,
    priority: null,
    opening_cents: null,
    note: null,
    balance_from: "covered",
    plan_account_id: null,
    covers: ["0b6f1d1e-7f0e-4c9e-9a51-3c1c2f6a0001"],
  };
  it("takes a plan whose balance is its debts added up, with no account", () => {
    expect(debtPlanFieldsSchema.safeParse(fields).success).toBe(true);
  });
  it("needs an account when the balance comes from one, and whole cents", () => {
    const noAccount = debtPlanFieldsSchema.safeParse({ ...fields, balance_from: "account" });
    expect(noAccount.success).toBe(false);
    expect(noAccount.error?.issues[0].message).toMatch(/Pick the account/);
    expect(debtPlanFieldsSchema.safeParse({ ...fields, payment_cents: 10.5 }).success).toBe(false);
    expect(debtPlanFieldsSchema.safeParse({ ...fields, covers: ["not-an-id"] }).success).toBe(
      false,
    );
  });
});
