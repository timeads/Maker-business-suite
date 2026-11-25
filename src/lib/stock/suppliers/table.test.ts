import { describe, expect, it } from "vitest";
import {
  adoptedDays,
  joinEmails,
  offersUse,
  parseEmailList,
  parseWhole,
  supplierTab,
  suppliersFor,
} from "./table";

describe("parseEmailList", () => {
  it("takes one address", () => {
    expect(parseEmailList(" Orders@HillMill.example ")).toEqual({
      email: "orders@hillmill.example",
      more: [],
    });
  });

  it("takes several, split by commas, semicolons or spaces, the first being where orders go", () => {
    expect(
      parseEmailList("dana@hillmill.example, accounts@hillmill.example;sales@hillmill.example"),
    ).toEqual({
      email: "dana@hillmill.example",
      more: ["accounts@hillmill.example", "sales@hillmill.example"],
    });
  });

  it("keeps each address once", () => {
    expect(parseEmailList("a@b.example, A@B.example, c@b.example")).toEqual({
      email: "a@b.example",
      more: ["c@b.example"],
    });
  });

  it("an empty box clears them all", () => {
    expect(parseEmailList("  ")).toEqual({ email: null, more: [] });
    expect(parseEmailList(" , ; ")).toEqual({ email: null, more: [] });
  });

  it("names the address that is wrong", () => {
    expect(parseEmailList("dana@hillmill.example, not-an-email")).toEqual({
      error: "“not-an-email” doesn't look like an email address.",
    });
    expect(parseEmailList("dana@hillmill")).toHaveProperty("error");
    expect(parseEmailList("@hillmill.example")).toHaveProperty("error");
  });

  it("allows six and refuses seven", () => {
    const list = (n: number) =>
      Array.from({ length: n }, (_, i) => `p${i}@hillmill.example`).join(", ");
    expect(parseEmailList(list(6))).toMatchObject({ email: "p0@hillmill.example" });
    expect(parseEmailList(list(7))).toHaveProperty("error");
  });

  it("round-trips with joinEmails", () => {
    const text = "dana@hillmill.example, accounts@hillmill.example";
    const parsed = parseEmailList(text);
    if ("error" in parsed) throw new Error("should parse");
    expect(joinEmails(parsed.email, parsed.more)).toBe(text);
  });
});

describe("joinEmails", () => {
  it("copes with nothing saved", () => {
    expect(joinEmails(null, null)).toBe("");
    expect(joinEmails(null, ["a@b.example"])).toBe("a@b.example");
  });
});

describe("offersUse", () => {
  it("is offered when the observed figure differs from the supplier's", () => {
    expect(offersUse(33, 45)).toBe(true);
    expect(offersUse(58, 50)).toBe(true);
  });

  it("is not offered when they already match, or there is nothing observed", () => {
    expect(offersUse(18, 18)).toBe(false);
    expect(offersUse(null, 18)).toBe(false);
    expect(offersUse(undefined, null)).toBe(false);
  });

  it("is offered for a supplier following the usual figure", () => {
    expect(offersUse(30, null)).toBe(true);
  });

  it("compares what would really be saved", () => {
    expect(offersUse(400, 365)).toBe(false);
    expect(adoptedDays(400)).toBe(365);
    expect(adoptedDays(-2)).toBe(0);
    expect(adoptedDays(17.6)).toBe(18);
  });
});

describe("parseWhole", () => {
  const lead = { min: 0, max: 365, empty: null };
  it("reads a whole number in range", () => {
    expect(parseWhole(" 45 ", lead)).toEqual({ value: 45 });
    expect(parseWhole("0", lead)).toEqual({ value: 0 });
  });
  it("gives what an empty box means", () => {
    expect(parseWhole("", lead)).toEqual({ value: null });
    expect(parseWhole("", { min: 1, max: 10, empty: 1 })).toEqual({ value: 1 });
  });
  it("refuses anything else", () => {
    for (const typed of ["366", "-1", "4.5", "ten", "1e2"]) {
      expect(parseWhole(typed, lead)).toEqual({ error: true });
    }
  });
});

describe("suppliersFor", () => {
  const rows = [
    { id: "3", name: "mill 10", archived_at: null },
    { id: "2", name: "Mill 2", archived_at: null },
    { id: "5", name: "Éclat Dyes", archived_at: null },
    { id: "4", name: "Old Loom Co", archived_at: "2026-01-05T00:00:00Z" },
    { id: "1", name: "alder yarns", archived_at: null },
    { id: "0", name: "Alder Yarns", archived_at: "2026-02-01T00:00:00Z" },
  ];

  it("lists the ones in use by name, capitals and accents aside, numbers as numbers", () => {
    expect(suppliersFor(rows, "active").map((s) => s.name)).toEqual([
      "alder yarns",
      "Éclat Dyes",
      "Mill 2",
      "mill 10",
    ]);
  });

  it("lists the archived ones on their own tab", () => {
    expect(suppliersFor(rows, "archived").map((s) => s.name)).toEqual([
      "Alder Yarns",
      "Old Loom Co",
    ]);
  });

  it("leaves the list it was given alone", () => {
    const before = rows.map((s) => s.id).join();
    suppliersFor(rows, "active");
    expect(rows.map((s) => s.id).join()).toBe(before);
  });
});

describe("supplierTab", () => {
  it("is active unless the address says archived", () => {
    expect(supplierTab(undefined)).toBe("active");
    expect(supplierTab("nonsense")).toBe("active");
    expect(supplierTab("archived")).toBe("archived");
  });
});
