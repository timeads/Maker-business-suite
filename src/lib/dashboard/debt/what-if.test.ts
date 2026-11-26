import { describe, expect, it } from "vitest";
import { projectPlan, type PlanDebt, type PlanInput, type Strategy } from "./engine";
import {
  applyWhatIf,
  askWhatIf,
  buildWhatIfPrompt,
  changeWords,
  tidyWhatIf,
  whatIfChangesSchema,
  whatIfFigures,
  type WhatIfAnswer,
} from "./what-if";

const CARD = "11111111-1111-4111-8111-111111111111";
const LOAN = "22222222-2222-4222-8222-222222222222";

const debt = (over: Partial<PlanDebt> & Pick<PlanDebt, "id" | "name">): PlanDebt => ({
  balance: 0,
  rateBp: 0,
  minimum: 0,
  payment: null,
  plan: "pool",
  revolvingBp: null,
  priority: null,
  active: true,
  ...over,
});

const BASE: PlanInput & { strategy: Strategy } = {
  start: "2026-11",
  averageRevenue: 0,
  revenueSharePct: 7,
  emergency: { target: 0, current: 0, splitPct: 30, monthly: 0 },
  overrides: new Map(),
  strategy: "avalanche",
  debts: [
    debt({ id: "freed", name: "Old", balance: 0, payment: 30_000 }),
    debt({
      id: CARD,
      name: "Card <one>",
      balance: 400_000,
      rateBp: 2_299,
      minimum: 12_000,
      priority: 1,
    }),
    debt({ id: LOAN, name: "Loan", balance: 900_000, rateBp: 900, minimum: 25_000, priority: 2 }),
  ],
};

const answer = (changes: WhatIfAnswer["changes"], understood = true): WhatIfAnswer => ({
  understood,
  summary: "Paying more each month.",
  changes,
});
const change = (
  what: WhatIfAnswer["changes"][number]["what"],
  over: Partial<WhatIfAnswer["changes"][number]> = {},
) => ({
  what,
  debt: "",
  amount: 0,
  strategy: "",
  ...over,
});

describe("the prompt", () => {
  const prompt = buildWhatIfPrompt(BASE.debts.slice(1), "What if I paid 200 more?", {
    currency: "USD",
    strategy: "avalanche",
  });
  it("shows the debts under our references and figures, never an id", () => {
    expect(prompt).toContain("D1 | name: Card ‹one› | owed: 4000.00 | rate: 22.99% a year");
    expect(prompt).toContain("D2 | name: Loan");
    expect(prompt).not.toContain(CARD);
    expect(prompt).not.toContain(LOAN);
  });
  it("marks the question and the names as material", () => {
    expect(prompt).toMatch(/<debts>[\s\S]*<\/debts>/);
    expect(prompt).toMatch(/<question>\nWhat if I paid 200 more\?\n<\/question>/);
  });
});

describe("tidying Claude's answer", () => {
  const ids = [CARD, LOAN];
  it("keeps the listed changes, in cents, against our own debts", () => {
    const tidy = tidyWhatIf(
      answer([
        change("extra_each_month", { amount: 200 }),
        change("pay_now", { debt: "d1", amount: 1500.5 }),
        change("rate", { debt: "D2", amount: 6.25 }),
        change("strategy", { strategy: "Snowball" }),
        change("emergency_share", { amount: 50 }),
      ]),
      ids,
    );
    expect(tidy.understood).toBe(true);
    expect(tidy.changes).toEqual({
      extraEachMonth: 20_000,
      strategy: "snowball",
      emergencySharePct: 50,
      debts: [
        { id: CARD, payNow: 150_050 },
        { id: LOAN, rateBp: 625 },
      ],
    });
    expect(whatIfChangesSchema.safeParse(tidy.changes).success).toBe(true);
  });

  it("drops what it can't use: unknown debts, bad amounts, other orders", () => {
    const tidy = tidyWhatIf(
      answer([
        change("pay_now", { debt: "D9", amount: 100 }),
        change("payment", { debt: CARD, amount: 100 }),
        change("extra_each_month", { amount: -50 }),
        change("minimum", { debt: "D1", amount: Number.NaN }),
        change("strategy", { strategy: "pay the biggest" }),
        change("emergency_share", { amount: 12.5 }),
      ]),
      ids,
    );
    expect(tidy).toMatchObject({ understood: false, changes: { debts: [] } });
  });

  it("isn't understood with nothing to try, or an answer of the wrong shape", () => {
    expect(tidyWhatIf(answer([], true), ids).understood).toBe(false);
    expect(tidyWhatIf({ nope: 1 }, ids).understood).toBe(false);
    expect(tidyWhatIf(answer([change("leave_out", { debt: "D1" })], false), ids).understood).toBe(
      false,
    );
  });

  it("keeps the summary short and inert", () => {
    const tidy = tidyWhatIf(
      { ...answer([change("leave_out", { debt: "D1" })]), summary: "<b>x</b>".repeat(40) },
      ids,
    );
    expect(tidy.summary).not.toMatch(/[<>]/);
    expect(tidy.summary.length).toBeLessThanOrEqual(160);
  });
});

describe("working a what-if out", () => {
  it("makes the changes to a copy of the plan's figures only", () => {
    const changed = applyWhatIf(BASE, {
      extraEachMonth: 5_000,
      strategy: "snowball",
      emergencyEachMonth: 1_000,
      debts: [
        { id: CARD, payNow: 100_000, rateBp: 1_000 },
        { id: LOAN, leaveOut: true },
      ],
    });
    expect(changed.strategy).toBe("snowball");
    expect(changed.extraEachMonth).toBe(5_000);
    expect(changed.emergency.monthly).toBe(1_000);
    expect(changed.debts.map((d) => [d.id, d.balance, d.rateBp])).toEqual([
      ["freed", 0, 0],
      [CARD, 300_000, 1_000],
    ]);
    expect(BASE.debts[1].balance).toBe(400_000);
  });

  it("an extra each month reaches the debts even when the pool doesn't cover the minimums", () => {
    const plan = projectPlan({ ...BASE, months: 1, extraEachMonth: 10_000 });
    expect(plan[0]).toMatchObject({ pool: 30_000, extraIn: 10_000, poolBudget: 40_000 });
    const figures = whatIfFigures(BASE, { extraEachMonth: 10_000, debts: [] });
    expect(figures.whatIf.months!).toBeLessThan(figures.now.months!);
    expect(figures.whatIf.interest).toBeLessThan(figures.now.interest);
  });

  it("an extra is set aside once no debt is left for it", () => {
    const plan = projectPlan({
      ...BASE,
      months: 1,
      debts: [BASE.debts[0]],
      extraEachMonth: 10_000,
    });
    expect(plan[0]).toMatchObject({ extraIn: 0, emergencyIn: 40_000 });
  });

  it("gives the engine's figures for both, every time the same", () => {
    const figures = whatIfFigures(BASE, { debts: [{ id: CARD, payNow: 400_000 }] });
    expect(figures.now.payoffs.map((p) => p.id)).toEqual([CARD, LOAN]);
    expect(figures.whatIf.payoffs.map((p) => p.id)).toEqual([LOAN]);
    expect(whatIfFigures(BASE, { debts: [{ id: CARD, payNow: 400_000 }] })).toEqual(figures);
  });

  it("says what was tried in plain words, by the debts' names", () => {
    const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
    expect(
      changeWords(
        {
          extraEachMonth: 20_000,
          strategy: "hybrid",
          debts: [{ id: CARD, rateBp: 625, leaveOut: true }],
        },
        new Map([[CARD, "Card"]]),
        money,
      ),
    ).toEqual([
      "$200.00 more toward the debts each month",
      "Paying extra in the hybrid order",
      "Card left out of the plan",
      "Card: 6.25% a year",
    ]);
  });
});

describe("asking Claude", () => {
  it("asks with structured output and no tools, and counts the tokens", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      beta: {
        messages: {
          parse: async (request: Record<string, unknown>) => {
            calls.push(request);
            return {
              stop_reason: "end_turn",
              usage: { input_tokens: 100, output_tokens: 20 },
              parsed_output: answer([change("extra_each_month", { amount: 1 })]),
            };
          },
        },
      },
    };
    const result = await askWhatIf(
      BASE.debts,
      "What if?",
      { currency: "USD", strategy: "avalanche" },
      client as never,
    );
    expect(result).toMatchObject({ ok: true, tokens: 120 });
    expect(calls[0]).not.toHaveProperty("tools");
    expect(calls[0]).toHaveProperty("output_config.format");
  });

  it("says when Claude declined", async () => {
    const client = {
      beta: {
        messages: {
          parse: async () => ({
            stop_reason: "refusal",
            usage: { input_tokens: 1, output_tokens: 1 },
            parsed_output: null,
          }),
        },
      },
    };
    expect(
      await askWhatIf([], "x", { currency: "USD", strategy: "avalanche" }, client as never),
    ).toEqual({
      ok: false,
      reason: "declined",
      tokens: 2,
    });
  });
});
