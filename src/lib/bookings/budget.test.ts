import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET,
  budgetSettingsSchema,
  budgetTotals,
  fixedForMonths,
  materialsPerStudent,
  periodFor,
  sessionCosts,
  sqftRate,
  type BudgetSession,
} from "./budget";

const NOW = new Date("2027-03-15T12:00:00Z");
const settings = budgetSettingsSchema.parse({
  version: 1,
  teachers: [
    { id: "me", name: "You", hourly_cents: 2000 },
    { id: "pat", name: "Pat", hourly_cents: 3000 },
  ],
  overhead_hours: 2,
  waste_percent: 10,
});
const session = (over: Partial<BudgetSession> = {}): BudgetSession => ({
  id: "x",
  service_id: "w1",
  starts_at: "2027-03-10T17:00:00Z",
  ends_at: "2027-03-10T20:00:00Z",
  cancelled: false,
  seats: 4,
  frame_width_in: 24,
  frame_height_in: 24,
  ...over,
});

describe("the budget", () => {
  it("prices teaching as hours plus prep at the teacher's rate, or the date's own fee", () => {
    const rows = sessionCosts(
      [
        session({ id: "a" }),
        session({
          id: "b",
          starts_at: "2027-03-11T17:00:00Z",
          ends_at: "2027-03-11T19:00:00Z",
          costs: {
            teacher: "pat",
            teaching_cents: null,
            frame_width_in: null,
            frame_height_in: null,
          },
        }),
        session({
          id: "c",
          starts_at: "2027-03-12T17:00:00Z",
          costs: {
            teacher: null,
            teaching_cents: 5000,
            frame_width_in: null,
            frame_height_in: null,
          },
        }),
        session({ id: "d", cancelled: true }),
      ],
      { settings, perStudent: new Map(), sqftCentiCents: 0, now: NOW },
    );
    expect(rows.map((r) => [r.session.id, r.teaching_cents])).toEqual([
      ["a", 10000], // (3 + 2) × $20
      ["b", 12000], // (2 + 2) × $30
      ["c", 5000],
    ]);
  });

  it("counts a teacher once for classes that start together, on the longest", () => {
    const rows = sessionCosts(
      [
        session({ id: "long" }),
        session({ id: "short", service_id: "w2", ends_at: "2027-03-10T18:00:00Z" }),
        session({
          id: "other",
          costs: {
            teacher: "pat",
            teaching_cents: null,
            frame_width_in: null,
            frame_height_in: null,
          },
        }),
      ],
      { settings, perStudent: new Map(), sqftCentiCents: 0, now: NOW },
    );
    const by = Object.fromEntries(rows.map((r) => [r.session.id, r]));
    expect(by.long.teaching_cents).toBe(10000);
    expect(by.short).toMatchObject({ teaching_cents: 0, shared_teacher: true });
    expect(by.other.teaching_cents).toBe(15000);
  });

  it("prices materials by the square foot with waste, plus each supply a person uses, in whole cents", () => {
    const perStudent = materialsPerStudent(
      [
        { id: "glue", active: true, per_student: 0.5, unit_cost_cents: 301 },
        { id: "old", active: false, per_student: 1, unit_cost_cents: 999 },
      ],
      [
        { supply_id: "glue", service_id: "w1" },
        { supply_id: "old", service_id: "w1" },
      ],
    );
    // $0.45 and $0.30 a square foot = 7500 hundredths of a cent.
    const rate = sqftRate([
      { active: true, centi_cents_per_sqft: 4500 },
      { active: true, centi_cents_per_sqft: 3000 },
      { active: false, centi_cents_per_sqft: 99999 },
    ]);
    expect(rate).toBe(7500);
    const [row] = sessionCosts(
      [
        session({
          costs: { teacher: null, teaching_cents: 0, frame_width_in: 18, frame_height_in: 18 },
        }),
      ],
      {
        settings,
        perStudent,
        sqftCentiCents: rate,
        now: NOW,
      },
    );
    // 18 × 18 in = 2.25 sq ft × 75¢ × 1.1 = 185.625¢, + 150.5¢ glue = 336.125¢ × 4 = 1344.5 → 1345
    expect(row.materials_cents).toBe(1345);
    expect(row.frame).toBe("18 × 18 in");
  });

  it("counts fixed costs for each month that has begun, at that month's amounts", () => {
    const costs = [
      { active: true, monthly_cents: 100000, from_month: "2000-01-01", to_month: "2027-01-01" },
      { active: true, monthly_cents: 120000, from_month: "2027-02-01", to_month: null },
      { active: false, monthly_cents: 5000, from_month: "2000-01-01", to_month: null },
    ];
    expect(fixedForMonths(costs, ["2027-01", "2027-02", "2027-03"])).toBe(340000);
  });

  it("leaves classes still to come out of the totals", () => {
    const rows = sessionCosts(
      [
        session({ id: "done" }),
        session({ id: "soon", starts_at: "2027-03-20T17:00:00Z", ends_at: "2027-03-20T20:00:00Z" }),
      ],
      { settings, perStudent: new Map(), sqftCentiCents: 0, now: NOW },
    );
    const totals = budgetTotals(rows, 50000, 80000, 20000);
    expect(totals).toEqual({
      teaching_cents: 10000,
      materials_cents: 0,
      fixed_cents: 50000,
      costs_cents: 60000,
      revenue_cents: 100000,
      net_cents: 40000,
      margin: 40,
      students: 4,
      classes: 1,
    });
    expect(budgetTotals([], 0, 0, 0).margin).toBeNull();
  });

  it("reads periods on the workspace's own calendar, counting only months begun", () => {
    expect(periodFor("this_quarter", "2027-02-10")).toMatchObject({
      months: ["2027-01", "2027-02", "2027-03"],
      begun: ["2027-01", "2027-02"],
      from: "2027-01-01",
      until: "2027-04-01",
    });
    expect(periodFor("last_month", "2027-01-05")).toMatchObject({
      months: ["2026-12"],
      label: "Last month",
    });
    expect(periodFor("2026-07", "2027-01-05")).toMatchObject({
      months: ["2026-07"],
      label: "July 2026",
    });
    expect(periodFor("nonsense", "2027-01-05").months).toEqual(["2027-01"]);
  });

  it("starts with two teachers at no cost, and each teacher once", () => {
    expect(DEFAULT_BUDGET.teachers.map((t) => t.id)).toEqual(["me", "contractor"]);
    expect(
      budgetSettingsSchema.safeParse({
        version: 1,
        teachers: [
          { id: "me", name: "A", hourly_cents: 1 },
          { id: "me", name: "B", hourly_cents: 1 },
        ],
      }).success,
    ).toBe(false);
  });
});
