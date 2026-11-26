import { describe, expect, it } from "vitest";
import {
  DEFAULT_CUTTER_SETTINGS,
  cutterSince,
  cutterSummary,
  cutterSettingsSchema,
  findRecurring,
  foldPayee,
  parseCutterSettings,
  type SpendRow,
} from "./recurring";

const S = DEFAULT_CUTTER_SETTINGS;
const TODAY = "2026-11-20";

const charge = (
  txn_date: string,
  amount_cents: number,
  payee: string | null = "Cloud Tools",
  account: string | null = "Software",
  sort: string | null = null,
): SpendRow => ({ txn_date, amount_cents, payee, account, sort });

/** One charge on the 5th of each of these months. */
const monthly = (months: string[], cents: number, payee?: string | null, account?: string) =>
  months.map((m) => charge(`${m}-05`, cents, payee, account));

describe("the settings", () => {
  it("default to the earlier dashboard's rule, with no amounts of its own", () => {
    expect(S).toMatchObject({
      months_back: 12,
      min_months: 3,
      growing_fast_pct: 25,
      creeping_pct: 5,
      new_months: 2,
      stopped_days: 60,
      small_cents: null,
      adds_up_cents: null,
      leave_out_accounts: [],
      leave_out_payees: [],
    });
    expect(parseCutterSettings({ version: 1, min_months: 1 })).toEqual(S);
    expect(cutterSettingsSchema.safeParse({ version: 1, small_cents: 0 }).success).toBe(false);
  });

  it("reads twelve months back, this one included", () => {
    expect(cutterSince(TODAY, S)).toBe("2025-12-01");
    expect(cutterSince("2026-01-31", { ...S, months_back: 3 })).toBe("2025-11-01");
  });
});

describe("folding a payee's spellings", () => {
  it("drops capitals, processor prefixes, web endings, company words and reference numbers", () => {
    expect(foldPayee("ACME.COM")).toBe("acme");
    expect(foldPayee("Acme Inc")).toBe("acme");
    expect(foldPayee("SQ *Acme")).toBe("acme");
    expect(foldPayee("The Acme Company")).toBe("acme");
    expect(foldPayee("Acme 4401-22")).toBe("acme");
    expect(foldPayee("Acme Tools")).toBe("acme tools");
  });
});

describe("finding recurring charges", () => {
  it("counts a payee seen in three or more months, monthly as total ÷ months seen", () => {
    const rows = [
      ...monthly(["2026-09", "2026-10", "2026-11"], 2999, "Cloud Tools"),
      // Two charges in one month still make one month.
      charge("2026-10-20", 1001, "CLOUD TOOLS INC"),
      ...monthly(["2026-10", "2026-11"], 5000, "Once Or Twice"),
    ];
    const found = findRecurring(rows, TODAY, S);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      key: "cloud tools",
      payee: "Cloud Tools",
      total: 2999 * 3 + 1001,
      monthsSeen: 3,
      charges: 4,
      monthly: Math.round((2999 * 3 + 1001) / 3),
      firstSeen: "2026-09-05",
      lastSeen: "2026-11-05",
    });
    expect(found[0].yearly).toBe(found[0].monthly * 12);
  });

  it("leaves out refunds, set-aside expenses, old charges and what the workspace leaves out", () => {
    const months = ["2026-08", "2026-09", "2026-10"];
    const rows = [
      ...months.map((m) => charge(`${m}-01`, -500)),
      ...months.map((m) => charge(`${m}-01`, 500, "Owner", "Draws", "set_aside")),
      ...monthly(["2024-01", "2024-02", "2024-03"], 500, "Long Ago"),
      ...monthly(months, 500, "Lender Payments", "Loan"),
      ...monthly(months, 500, "Payroll Service", "Wages"),
      ...monthly(months, 500, "Kept", "Software"),
    ];
    const found = findRecurring(rows, TODAY, {
      ...S,
      leave_out_accounts: [" loan "],
      leave_out_payees: ["payroll"],
    });
    expect(found.map((c) => c.payee)).toEqual(["Kept"]);
  });

  it("names it by its account when the books have no payee", () => {
    const found = findRecurring(
      monthly(["2026-08", "2026-09", "2026-10"], 100, null, "Internet"),
      TODAY,
      S,
    );
    expect(found[0]).toMatchObject({ payee: "Internet", account: "Internet" });
  });

  it("flags growing fast and creeping up from the last six months against the six before", () => {
    const before = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05"];
    const after = ["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"];
    const fast = [...monthly(before, 1000, "Fast"), ...monthly(after, 1300, "Fast")];
    const creep = [
      ...monthly(before, 1000, "Creep", "Other"),
      ...monthly(after, 1060, "Creep", "Other"),
    ];
    const flat = [
      ...monthly(before, 1000, "Flat", "Third"),
      ...monthly(after, 1000, "Flat", "Third"),
    ];
    const found = findRecurring([...fast, ...creep, ...flat], TODAY, S);
    const by = (payee: string) => found.find((c) => c.payee === payee)!;
    expect(by("Fast").trend).toBeCloseTo(0.3);
    expect(by("Fast").flags).toContain("growing");
    expect(by("Creep").flags).toContain("creeping");
    expect(by("Creep").flags).not.toContain("growing");
    expect(by("Flat").flags).toEqual([]);
  });

  it("flags new, stopped, and two payees on one account", () => {
    const rows = [
      ...monthly(["2026-09", "2026-10", "2026-11"], 100, "Newcomer", "Apps"),
      ...monthly(["2026-02", "2026-03", "2026-09"], 100, "Quiet", "Apps"),
    ];
    const found = findRecurring(rows, TODAY, S);
    const by = (payee: string) => found.find((c) => c.payee === payee)!;
    expect(by("Newcomer").flags).toEqual(["new", "overlap"]);
    // Last charged Sep 5: 76 days before Nov 20.
    expect(by("Quiet").flags).toEqual(["stopped", "overlap"]);
  });

  it("flags small but adding up only once the workspace sets both amounts", () => {
    const rows = monthly(["2026-09", "2026-10", "2026-11"], 900, "Little", "Apps");
    expect(findRecurring(rows, TODAY, S)[0].flags).not.toContain("small");
    const set = { ...S, small_cents: 1000, adds_up_cents: 10000 };
    expect(findRecurring(rows, TODAY, set)[0].flags).toContain("small");
  });

  it("lists the biggest yearly cost first, and the account charged most", () => {
    const rows = [
      ...monthly(["2026-09", "2026-10", "2026-11"], 100, "Small"),
      ...monthly(["2026-09", "2026-10"], 5000, "Big", "Rent"),
      charge("2026-11-01", 9000, "BIG", "Rent:Studio"),
    ];
    const found = findRecurring(rows, TODAY, S);
    expect(found.map((c) => c.payee)).toEqual(["Big", "Small"]);
    expect(found[0].account).toBe("Rent");
    expect(found[0].accounts).toEqual(["Rent", "Rent:Studio"]);
  });
});

describe("the headline", () => {
  it("adds up the monthly spend, its share of revenue and the savings planned", () => {
    const found = findRecurring(
      [
        ...monthly(["2026-09", "2026-10", "2026-11"], 1000, "A", "One"),
        ...monthly(["2026-09", "2026-10", "2026-11"], 3000, "B", "Two"),
        ...monthly(["2026-08", "2026-09", "2026-10"], 500, "C", "Three"),
      ],
      TODAY,
      S,
    );
    const summary = cutterSummary(
      found,
      [
        { key: "a", decision: "cancel", decided_at: "2026-11-01T00:00:00Z", note: null },
        // Marked cancelled on Oct 1, charged again in November.
        {
          key: "b",
          decision: "cancelled",
          decided_at: "2026-10-01T12:00:00Z",
          note: "Called them",
        },
        { key: "c", decision: "cancelled", decided_at: "2026-11-01T00:00:00Z", note: null },
      ],
      45000,
    );
    expect(summary).toEqual({
      monthly: 4500,
      yearly: 54000,
      payees: 3,
      shareOfRevenue: 0.1,
      savingsPlanned: 4500,
      stillBilling: ["b"],
    });
    expect(cutterSummary(found, [], null).shareOfRevenue).toBeNull();
  });
});
