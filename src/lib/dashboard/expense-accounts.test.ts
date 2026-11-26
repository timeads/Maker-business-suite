import { describe, expect, it } from "vitest";
import {
  accountKey,
  accountsSummary,
  mergeAccounts,
  nextAccountChoices,
  readAccountRows,
  type BookAccount,
} from "./expense-accounts";
import { expenseSortingSchema } from "./expenses";

const account = (over: Partial<BookAccount>): BookAccount => ({
  ref: null,
  name: "Supplies",
  recent: 1,
  recentCents: 100,
  all: 1,
  toSort: 0,
  byAccount: 1,
  exceptions: 0,
  lastDay: "2026-10-01",
  ...over,
});

describe("the books' expense accounts", () => {
  it("reads the database's rows", () => {
    expect(
      readAccountRows([
        {
          account_ref: "61",
          account: "Supplies",
          recent: "3",
          recent_cents: "4500",
          all_count: 4,
          to_sort: "1",
          by_account: "2",
          exceptions: "1",
          last_day: "2026-10-05",
        },
        { account_ref: null, account: "  ", recent: 1 },
      ]),
    ).toEqual([
      account({
        ref: "61",
        recent: 3,
        recentCents: 4500,
        all: 4,
        toSort: 1,
        byAccount: 2,
        exceptions: 1,
        lastDay: "2026-10-05",
      }),
      account({
        name: null,
        recent: 1,
        recentCents: 0,
        all: 0,
        byAccount: 0,
        lastDay: null,
      }),
    ]);
  });

  it("folds expenses read without an id into the one account of that name", () => {
    const merged = mergeAccounts([
      account({ ref: "61", recentCents: 500, lastDay: "2026-09-01" }),
      account({ ref: null, recentCents: 200, toSort: 2, lastDay: "2026-10-01" }),
      account({ ref: null, name: "Rent", recentCents: 900 }),
    ]);
    expect(merged.map((a) => [a.ref, a.name, a.recentCents])).toEqual([
      [null, "Rent", 900],
      ["61", "Supplies", 700],
    ]);
    expect(merged[1]).toMatchObject({ toSort: 2, lastDay: "2026-10-01" });
  });

  it("never guesses between two accounts of the same name", () => {
    const merged = mergeAccounts([
      account({ ref: "61" }),
      account({ ref: "62" }),
      account({ ref: null, recentCents: 50 }),
    ]);
    expect(merged).toHaveLength(3);
  });

  it("counts the accounts still on the automatic default", () => {
    const settings = expenseSortingSchema.parse({
      version: 1,
      accounts: [
        { ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } },
        { ref: null, name: "Fees", action: { sort: "each" } },
      ],
    });
    expect(
      accountsSummary(settings, [
        account({ ref: "61" }),
        account({ ref: "62", name: "Fees", toSort: 4 }),
        account({ ref: "63", name: "Rent" }),
      ]),
    ).toEqual({ accounts: 3, automatic: 1, eachOne: 1, waiting: 4 });
  });
});

describe("saving the account choices", () => {
  const stored = expenseSortingSchema.parse({
    version: 1,
    accounts: [
      { ref: null, name: "Supplies", action: { sort: "line", line: "shop" } },
      { ref: "90", name: "Closed Account", action: { sort: "set_aside" } },
      { ref: "62", name: "Rent", action: { sort: "shared" } },
    ],
  }).accounts;
  const listed = [
    account({ ref: "61", name: "Supplies" }),
    account({ ref: "62", name: "Rent" }),
    account({ ref: "63", name: "Fees" }),
    account({ ref: null, name: null }),
  ];

  it("writes what was picked, keeps what wasn't touched, and keys by the books' id", () => {
    const next = nextAccountChoices(
      stored,
      listed,
      new Map([
        [accountKey(listed[1]), null],
        [accountKey(listed[2]), { sort: "each" as const }],
      ]),
    );
    expect(next).toEqual([
      // Untouched, now kept by the books' id.
      { ref: "61", name: "Supplies", action: { sort: "line", line: "shop" } },
      // Rent went back to the automatic default; Fees is picked.
      { ref: "63", name: "Fees", action: { sort: "each" } },
      // An account the books no longer use keeps its choice.
      { ref: "90", name: "Closed Account", action: { sort: "set_aside" } },
    ]);
    expect(expenseSortingSchema.safeParse({ version: 1, accounts: next }).success).toBe(true);
  });
});

describe("the last twelve months", () => {
  it("starts a year before today, a leap day landing on the 28th", async () => {
    const { yearBefore } = await import("./expense-accounts");
    expect(yearBefore("2026-11-26")).toBe("2025-11-26");
    expect(yearBefore("2028-02-29")).toBe("2027-02-28");
  });
});
