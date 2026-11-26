import { describe, expect, it } from "vitest";
import { basicsWords, debtBasicsSchema, withBasics } from "./basics";

const ROW = {
  id: "d1",
  name: "Studio card",
  kind: "card",
  plan: "pool",
  status: "active",
  rate_bp: null,
  minimum_cents: "2500",
  payment_cents: null,
  revolving_bp: null,
  due_day: 12,
  priority: 2,
  opening_cents: "400000",
  books_account: "Studio Card",
  note: "kept as it is",
};
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

describe("withBasics", () => {
  it("changes only what it's handed and keeps everything else as stored", () => {
    expect(withBasics(ROW, { rate_bp: 1999 })).toEqual({
      name: "Studio card",
      kind: "card",
      plan: "pool",
      status: "active",
      rate_bp: 1999,
      minimum_cents: 2500,
      payment_cents: null,
      revolving_bp: null,
      due_day: 12,
      priority: 2,
      opening_cents: 400000,
      books_account: "Studio Card",
      note: "kept as it is",
    });
    expect(withBasics({ ...ROW, rate_bp: 1999 }, { rate_bp: null })?.rate_bp).toBeNull();
    expect(withBasics(ROW, { payment_cents: 9000, due_day: null })).toMatchObject({
      payment_cents: 9000,
      due_day: null,
      minimum_cents: 2500,
    });
  });

  it("refuses a row that doesn't fit", () => {
    expect(withBasics({ ...ROW, kind: "boat" }, { rate_bp: 100 })).toBeNull();
  });
});

describe("debtBasicsSchema", () => {
  it("takes only the basics, and something to change", () => {
    expect(debtBasicsSchema.safeParse({ rate_bp: 1000 }).success).toBe(true);
    expect(debtBasicsSchema.safeParse({}).success).toBe(false);
    expect(debtBasicsSchema.safeParse({ name: "New name" }).success).toBe(false);
    expect(debtBasicsSchema.safeParse({ minimum_cents: -1 }).success).toBe(false);
  });
});

describe("basicsWords", () => {
  it("shows before and after for what changes", () => {
    expect(basicsWords(ROW, { rate_bp: 1000, minimum_cents: 5000 }, money)).toEqual({
      before: ["No rate given", "Minimum: $25.00"],
      after: ["Rate 10%", "Minimum: $50.00"],
    });
  });
});
