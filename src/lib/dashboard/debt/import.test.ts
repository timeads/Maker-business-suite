import { describe, expect, it } from "vitest";
import { matchDebt, planDebtImport, readDebtFile, type ImportDebt } from "./import";

/** Made-up debts: no real lender, bank or account. */
const debt = (over: Partial<ImportDebt>): ImportDebt => ({
  id: "d1",
  name: "Studio Card",
  booksAccount: "Studio Card",
  rateBp: null,
  minimum: 0,
  payment: null,
  plan: "pool",
  priority: null,
  dueDay: null,
  note: null,
  savedByPerson: false,
  ...over,
});

describe("reading the file", () => {
  it("reads each column whatever its heading's capitals, in whole cents and basis points", () => {
    const file = readDebtFile(
      [
        "Account,Rate %,Minimum,Usual Payment,Plan,Priority,Due Day,Note",
        'Studio Card,22.99%,"$1,250.00",300,Share of sales,2,15th,Pay early',
        "Van Loan,6.5,,,fixed,,,",
      ].join("\n"),
    );
    expect(file).toEqual({
      ok: true,
      problems: [],
      rows: [
        {
          line: 2,
          name: "Studio Card",
          details: {
            rate_bp: 2299,
            minimum_cents: 125000,
            payment_cents: 30000,
            plan: "revenue_share",
            priority: 2,
            due_day: 15,
            note: "Pay early",
          },
        },
        { line: 3, name: "Van Loan", details: { rate_bp: 650, plan: "fixed" } },
      ],
    });
  });

  it("says which lines it couldn't use, and why", () => {
    const file = readDebtFile("name,rate,due day\nCard,lots,40\n,,\n,5,\n");
    expect(file.ok && file.problems).toEqual([
      { line: 2, text: "Card: we couldn't read the rate, the due day, so those are left out" },
      { line: 4, text: "has no name or account, so it's left out" },
    ]);
  });

  it("needs a column naming each debt", () => {
    expect(readDebtFile("rate,minimum\n5,10\n")).toMatchObject({ ok: false });
  });
});

describe("matching to the books' debts", () => {
  const debts = [
    debt({ id: "a", name: "Studio Card", booksAccount: "Studio Card" }),
    debt({ id: "b", name: "Van Loan", booksAccount: "VAN LOAN 2" }),
    debt({ id: "c", name: "Line A", booksAccount: "Line  A" }),
    debt({ id: "d", name: "linea", booksAccount: null }),
  ];

  it("takes the exact name first, then ignores capitals and spaces", () => {
    expect(matchDebt("Studio Card", debts)).toEqual({ debt: debts[0] });
    expect(matchDebt("van loan 2", debts)).toEqual({ debt: debts[1] });
  });

  it("never guesses between two", () => {
    expect(matchDebt("LINE A", debts)).toEqual({ several: true });
    expect(matchDebt("Nobody", debts)).toEqual({ none: true });
  });
});

describe("what the import fills", () => {
  it("fills only what a person hasn't set, and says what it keeps", () => {
    const debts = [
      debt({ id: "a", rateBp: 1999, savedByPerson: true, note: "Mine" }),
      debt({ id: "b", name: "Van Loan", booksAccount: "Van Loan" }),
    ];
    const plan = planDebtImport(
      [
        {
          line: 2,
          name: "Studio Card",
          details: { rate_bp: 2299, minimum_cents: 5000, plan: "fixed", note: "Theirs" },
        },
        { line: 3, name: "Van Loan", details: { plan: "fixed", due_day: 3 } },
        { line: 4, name: "Van Loan", details: { priority: 1 } },
        { line: 5, name: "Gone Card", details: { rate_bp: 100 } },
      ],
      debts,
    );
    expect(plan.fills).toEqual([
      {
        line: 2,
        debtId: "a",
        debtName: "Studio Card",
        details: { minimum_cents: 5000 },
        kept: ["rate", "plan", "note"],
      },
      {
        line: 3,
        debtId: "b",
        debtName: "Van Loan",
        details: { plan: "fixed", due_day: 3 },
        kept: [],
      },
    ]);
    expect(plan.skipped.map((s) => s.line)).toEqual([4, 5]);
  });

  it("changes nothing the second time, once the fields are set", () => {
    const filled = debt({
      rateBp: 2299,
      minimum: 5000,
      payment: 1,
      priority: 1,
      dueDay: 2,
      note: "x",
      savedByPerson: true,
    });
    const plan = planDebtImport(
      [{ line: 2, name: "Studio Card", details: { rate_bp: 2299, minimum_cents: 5000 } }],
      [filled],
    );
    expect(plan.fills).toEqual([]);
    expect(plan.skipped[0].text).toMatch(/set already/);
  });
});

describe("the preview's words", () => {
  it("says each filled detail plainly", async () => {
    const { detailWords } = await import("./import");
    expect(
      detailWords(
        { rate_bp: 2299, minimum_cents: 5000, plan: "fixed", due_day: 3 },
        (c) => `$${(c / 100).toFixed(2)}`,
      ),
    ).toEqual(["rate 22.99%", "minimum $50.00", "fixed payment", "due on day 3"]);
  });
});
