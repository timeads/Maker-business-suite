import { describe, expect, it } from "vitest";
import {
  MAX_IMPORT_ROWS,
  inferStatus,
  itemFinder,
  readImport,
  readWhen,
  shiftDay,
  type ImportKind,
  type ItemRef,
} from "./files";

const ITEMS: ItemRef[] = [
  { id: "rug", sku: "RUG-L", title: "Wool rug", variant_title: "Large" },
  { id: "yarn", sku: null, title: "Yarn bundle", variant_title: null },
  { id: "twin-1", sku: "TWIN", title: "Twin", variant_title: "Red" },
  { id: "twin-2", sku: "twin", title: "Twin", variant_title: "Blue" },
];
const TODAY = "2026-11-24";
const NOW = "2026-11-24T15:00:00.000Z";
const read = (kind: ImportKind, text: string) => {
  const out = readImport(kind, text, { items: ITEMS, today: TODAY, now: NOW });
  if (!out.ok) throw new Error(out.error);
  return out;
};
const refuse = (kind: ImportKind, text: string) => {
  const out = readImport(kind, text, { items: ITEMS, today: TODAY, now: NOW });
  if (out.ok) throw new Error("expected the file to be refused");
  return out.error;
};

describe("finding the item a row is about", () => {
  const find = itemFinder(ITEMS);
  it("goes by SKU first, whatever the capitals", () => {
    expect(find("rug-l", "", "")).toEqual({ id: "rug" });
  });
  it("falls back to product and option when there is no SKU to go by", () => {
    expect(find("", "yarn bundle", "")).toEqual({ id: "yarn" });
    expect(find("", "Yarn bundle", "Default Title")).toEqual({ id: "yarn" });
    expect(find("OLD-SKU", "Wool rug", "Large")).toEqual({ id: "rug" });
  });
  it("won't guess between two items", () => {
    expect(find("TWIN", "", "")).toEqual({
      why: "2 items in your shop share the SKU “TWIN”, so we can't tell which one this is",
    });
    // The product and option still settle it.
    expect(find("TWIN", "Twin", "Blue")).toEqual({ id: "twin-2" });
  });
  it("says what it looked for when nothing matches", () => {
    expect(find("NOPE", "", "")).toEqual({ why: "No item in your shop has the SKU “NOPE”" });
    expect(find("", "Felt", "Grey")).toEqual({
      why: "No item in your shop is called “Felt — Grey”",
    });
    expect(find("", "", "")).toEqual({
      why: "This row has no SKU and no product name to find the item by",
    });
  });
});

describe("dates", () => {
  it("reads the three ways a date is usually written", () => {
    expect(readWhen("2026-03-04")).toEqual({ day: "2026-03-04", at: "2026-03-04T12:00:00.000Z" });
    expect(readWhen("3/4/2026")).toEqual({ day: "2026-03-04", at: "2026-03-04T12:00:00.000Z" });
    expect(readWhen("2026-03-04 15:20:00")).toEqual({
      day: "2026-03-04",
      at: "2026-03-04T15:20:00.000Z",
    });
    expect(readWhen("2026-03-04T15:20:00-05:00")?.at).toBe("2026-03-04T20:20:00.000Z");
  });
  it("turns down a day that doesn't exist", () => {
    expect(readWhen("2026-02-30")).toBeNull();
    expect(readWhen("13/01/2026")).toBeNull();
    expect(readWhen("next week")).toBeNull();
    expect(readWhen("1999-12-31")).toBeNull();
  });
  it("moves a day across a month end", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-11-24", -200)).toBe("2026-05-08");
  });
});

describe("files that can't be read at all", () => {
  it("names the column that is missing, and the ones the file has", () => {
    expect(refuse("suppliers", "vendor,moq\nHill,1\n")).toBe(
      "A suppliers file needs a column called “name”. This file's columns are: vendor, moq.",
    );
    expect(refuse("counts", "date,on_hand\n2026-11-01,0\n")).toMatch(/“sku” \(or “product”\)/);
  });
  it("turns down a file with no rows, too many rows, or too many bytes", () => {
    expect(refuse("suppliers", "name\n")).toBe("That file has headings but no rows under them.");
    const many =
      "name\n" +
      Array.from({ length: MAX_IMPORT_ROWS.suppliers + 1 }, (_, i) => `S${i}`).join("\n");
    expect(refuse("suppliers", many)).toMatch(
      /2,001 rows; the most we take at once for suppliers is 2,000/,
    );
    expect(refuse("suppliers", `name,notes\nA,${"x".repeat(4_100_000)}\n`)).toMatch(
      /bigger than 4 MB/,
    );
  });
});

describe("suppliers", () => {
  it("reads TuftStock's own columns", () => {
    const out = read(
      "suppliers",
      [
        "name,contact_name,contact_email,lead_time_days,moq,moq_applies_to,notes,archived",
        'Hill Mill Yarns,王小明,"Orders@HillMill.example; accounts@hillmill.example",45,22,ORDER,"Net 30, by sea",false',
        "Loom & Co,,,,,SKU,,yes",
      ].join("\n"),
    );
    expect(out.problems).toEqual([]);
    expect(out.read).toBe(2);
    expect(out.payload).toEqual([
      {
        name: "Hill Mill Yarns",
        contact_name: "王小明",
        emails: ["orders@hillmill.example", "accounts@hillmill.example"],
        lead_time_days: 45,
        moq: 22,
        moq_applies_to: "order",
        notes: "Net 30, by sea",
        archived: false,
      },
      // Empty figures are left out, so they stay as they are (or at their usual start).
      {
        name: "Loom & Co",
        contact_name: "",
        emails: [],
        moq_applies_to: "sku",
        notes: "",
        archived: true,
      },
    ]);
  });

  it("leaves a bad row out and says why, by line", () => {
    const out = read(
      "suppliers",
      [
        "name,email,lead_time_days,moq,archived",
        "Good One,a@good.example,30,1,no",
        ",b@x.example,30,1,no",
        "Slow Boat,c@x.example,400,1,no",
        "Typo Mill,not-an-email@,30,1,no",
        "Half Mill,d@x.example,30,2.5,no",
        "good one,e@x.example,30,1,no",
        "Maybe Mill,f@x.example,30,1,perhaps",
      ].join("\n"),
    );
    expect(out.payload.map((row) => row.name)).toEqual(["Good One"]);
    expect(out.problems).toEqual([
      { line: 3, reason: "This row has no supplier name" },
      { line: 4, reason: "lead time in days should be between 0 and 365, not 400" },
      { line: 5, reason: "“not-an-email@” isn't an email address" },
      { line: 6, reason: "“2.5” isn't a whole number (smallest order)" },
      { line: 7, reason: "“good one” is already on line 2; this second row was left out" },
      { line: 8, reason: "“perhaps” should be yes or no (archived)" },
    ]);
  });

  it("reads yes and no the ways a spreadsheet or a database writes them", () => {
    const out = read("suppliers", "name,archived\nA,t\nB,f\nC,TRUE\nD,No\nE,\nF,1\n");
    // An empty cell says nothing either way.
    expect(out.payload.map((row) => row.archived)).toEqual([
      true,
      false,
      true,
      false,
      undefined,
      true,
    ]);
  });

  it("only touches what the file has a column for", () => {
    expect(read("suppliers", "name\nHill Mill Yarns\n").payload).toEqual([
      { name: "Hill Mill Yarns" },
    ]);
  });
});

describe("item planning", () => {
  it("matches by SKU, else product and option, and sets the columns the file has", () => {
    const out = read(
      "items",
      [
        "sku,product,option,primary_supplier,supplier_sku,cost,lead_time_override,coverage_days,safety_stock,moq,case_pack_size,dont_reorder,hidden",
        "RUG-L,,,Hill Mill Yarns,HM-RUG,$41.50,60,45,10,6,12,false,false",
        ",Yarn bundle,,,,,,,,,,true,false",
      ].join("\n"),
    );
    expect(out.problems).toEqual([]);
    expect(out.payload).toEqual([
      {
        stock_item_id: "rug",
        supplier: "Hill Mill Yarns",
        supplier_sku: "HM-RUG",
        own_cost: "41.50",
        lead_time_days: 60,
        coverage_days: 45,
        safety_stock: 10,
        moq: 6,
        case_pack: 12,
        hidden: false,
        dont_reorder: false,
      },
      // No supplier named: left with whoever it has. Empty figures are cleared.
      {
        stock_item_id: "yarn",
        supplier_sku: null,
        own_cost: null,
        lead_time_days: null,
        coverage_days: null,
        safety_stock: 0,
        moq: null,
        case_pack: null,
        // "Don't reorder" and "hidden" are two switches: each column sets its own.
        hidden: false,
        dont_reorder: true,
      },
    ]);
  });

  it("leaves alone every figure the file has no column for", () => {
    expect(read("items", "sku,case_pack\nRUG-L,36\n").payload).toEqual([
      { stock_item_id: "rug", case_pack: 36 },
    ]);
  });

  it("reports rows it can't place or can't read", () => {
    const out = read(
      "items",
      [
        "sku,own_cost,case_pack",
        "NOPE,1,1",
        "TWIN,1,1",
        "RUG-L,-4,1",
        "RUG-L,4,0",
        "RUG-L,4,1",
        "RUG-L,5,1",
      ].join("\n"),
    );
    expect(out.payload).toEqual([{ stock_item_id: "rug", own_cost: "4.00", case_pack: 1 }]);
    expect(out.problems).toEqual([
      { line: 2, reason: "No item in your shop has the SKU “NOPE”" },
      {
        line: 3,
        reason: "2 items in your shop share the SKU “TWIN”, so we can't tell which one this is",
      },
      { line: 4, reason: "your own cost can't be less than zero" },
      { line: 5, reason: "case size should be between 1 and 100,000, not 0" },
      { line: 7, reason: "This item is already on line 6; this second row was left out" },
    ]);
  });
});

describe("purchase orders", () => {
  const HEAD =
    "reference,supplier,status,created_at,sent_at,expected_at,sku,title,qty_ordered,qty_received,unit_cost,shipping_cost,tax_rate_pct,adjustments,notes";

  it("groups rows into orders, open and part-received ones included", () => {
    const out = read(
      "orders",
      [
        HEAD,
        "HI-202603-E5A62F-SEA,Hill Mill Yarns,PARTIAL,2026-03-02,2026-03-04,2026-05-01,RUG-L,Wool rug,36,12,7.50,250.00,8.875,Pallet fee=25; Discount=-10.50,By sea",
        "HI-202603-E5A62F-SEA,Hill Mill Yarns,PARTIAL,2026-03-02,2026-03-04,2026-05-01,,Yarn bundle,10,10,2,250.00,8.875,,",
        "LO-202611-0000AA,Loom & Co,,,2026-11-10,,RUG-L,,5,0,7.5,,,,",
        "LO-202611-0000BB,Loom & Co,,,,,RUG-L,,5,0,7.5,,,,",
      ].join("\n"),
    );
    expect(out.problems).toEqual([]);
    expect(out.payload).toEqual([
      {
        reference: "HI-202603-E5A62F-SEA",
        supplier: "Hill Mill Yarns",
        status: "partial",
        created_at: "2026-03-02T12:00:00.000Z",
        ordered_at: "2026-03-04T12:00:00.000Z",
        expected_on: "2026-05-01",
        closed_at: null,
        shipping_cost: "250.00",
        tax_rate_pct: "8.875",
        notes: "By sea",
        adjustments: [
          { label: "Pallet fee", amount: "25.00" },
          { label: "Discount", amount: "-10.50" },
        ],
        lines: [
          {
            stock_item_id: "rug",
            qty_ordered: 36,
            qty_received: 12,
            unit_cost: "7.50",
            supplier_sku: "",
            note: "",
          },
          {
            stock_item_id: "yarn",
            qty_ordered: 10,
            qty_received: 10,
            unit_cost: "2.00",
            supplier_sku: "",
            note: "",
          },
        ],
      },
      expect.objectContaining({
        reference: "LO-202611-0000AA",
        status: "ordered",
        ordered_at: "2026-11-10T12:00:00.000Z",
      }),
      expect.objectContaining({
        reference: "LO-202611-0000BB",
        status: "draft",
        ordered_at: null,
        created_at: null,
      }),
    ]);
    expect(out.notes).toEqual([
      "2 of these are still open. What they say has already arrived is kept as history: your counts aren't raised and nothing is sent to your shop. What is still to come can be checked in as usual.",
    ]);
  });

  it("works out where an order stands when the file doesn't say, as TuftStock does", () => {
    expect(inferStatus(10, 0, false)).toBe("draft");
    expect(inferStatus(10, 0, true)).toBe("ordered");
    expect(inferStatus(10, 4, true)).toBe("partial");
    expect(inferStatus(10, 10, true)).toBe("closed");
    expect(inferStatus(10, 12, false)).toBe("closed");
  });

  it("lets the quantities settle a status that disagrees with them", () => {
    const status = (given: string, received: number) =>
      read(
        "orders",
        `${HEAD}\nAB-1,Hill,${given},2026-03-02,2026-03-04,,RUG-L,,10,${received},1,,,,`,
      ).payload[0].status;
    expect(status("ORDERED", 3)).toBe("partial");
    expect(status("PARTIAL", 0)).toBe("ordered");
    expect(status("ARCHIVED", 0)).toBe("cancelled");
    expect(status("ARCHIVED", 10)).toBe("closed");
    expect(status("CLOSED", 3)).toBe("closed");
    expect(status("DRAFT", 3)).toBe("partial");
  });

  it("keeps the cost of a line whose item is gone, so the order still adds up", () => {
    const out = read(
      "orders",
      [
        HEAD,
        "AB-1,Hill,CLOSED,2026-03-02,,,RUG-L,,2,2,10,,,,",
        "AB-1,Hill,CLOSED,2026-03-02,,,GONE-1,Old felt,3,3,4.25,,,,",
      ].join("\n"),
    );
    expect(out.payload[0].lines).toHaveLength(1);
    expect(out.payload[0].adjustments).toEqual([
      { label: "Items no longer in your shop (1 line)", amount: "12.75" },
    ]);
    expect(out.problems).toEqual([
      {
        line: 3,
        reason:
          "No item in your shop has the SKU “GONE-1”. Its cost stays on order AB-1 as one amount, so the order's total is still right",
      },
    ]);
    expect(out.notes[0]).toMatch(/^1 line names an item that isn't in your shop/);
  });

  it("joins the same item twice on one order into one line at its average cost", () => {
    const out = read(
      "orders",
      [
        HEAD,
        "AB-1,Hill,ORDERED,2026-03-02,,,RUG-L,,10,0,1.00,,,,",
        "AB-1,Hill,ORDERED,2026-03-02,,,rug-l,,30,0,2.00,,,,",
      ].join("\n"),
    );
    expect(out.payload[0].lines).toEqual([
      {
        stock_item_id: "rug",
        qty_ordered: 40,
        qty_received: 0,
        unit_cost: "1.75",
        supplier_sku: "",
        note: "",
      },
    ]);
  });

  it("leaves out an order it can't trust and says why", () => {
    const out = read(
      "orders",
      [
        HEAD,
        ",Hill,,,,,RUG-L,,1,0,1,,,,",
        "AB-1,Hill,,,,,RUG-L,,1,0,1,,,,",
        "AB-1,Loom,,,,,RUG-L,,1,0,1,,,,",
        "AB-2,,,,,,RUG-L,,1,0,1,,,,",
        "AB-3,Hill,SHIPPED,,,,RUG-L,,1,0,1,,,,",
        "AB-4,Hill,,02/30/2026,,,RUG-L,,1,0,1,,,,",
        "AB-5,Hill,,,,,RUG-L,,0,0,1,,,,",
        "AB-6,Hill,,,,,RUG-L,,lots,0,1,,,,",
        "AB-6,Hill,,,,,RUG-L,,2,0,1,,,Fee,",
      ].join("\n"),
    );
    expect(out.payload).toEqual([]);
    expect(out.problems.map((p) => [p.line, p.reason])).toEqual([
      [2, "This row has no order reference, so we can't tell which order it belongs to"],
      [3, "Order AB-1 names two suppliers (“Hill” and “Loom” on line 4), so it was left out"],
      [5, "Order AB-2 doesn't name a supplier, so it was left out"],
      [
        6,
        "“SHIPPED” isn't a status we know. Use DRAFT, ORDERED, PARTIAL, CLOSED or ARCHIVED, or leave it empty",
      ],
      [7, "“02/30/2026” isn't a date we can read (created_at). Write it like 2026-03-04"],
      [8, "Order AB-5 has nothing on it that we could read, so it was left out"],
      [9, "“Fee” isn't an adjustment we can read. Write each as Label=12.50, with ; between them"],
    ]);
  });

  it("reads the export TuftStock's own importer was written for", () => {
    const out = read(
      "orders",
      [
        "PO Number,Supplier,Date Placed,Expected Delivery Date,SKU,Product,Variant,Confirmed Qty,Received Qty,Confirmed Cost",
        'AB-9,Hill,2026-03-04,2026-05-01,RUG-L,Wool rug,Large,"1,200",0,"$1,000.50"',
      ].join("\n"),
    );
    expect(out.problems).toEqual([]);
    expect(out.payload[0]).toMatchObject({
      reference: "AB-9",
      status: "ordered",
      expected_on: "2026-05-01",
      lines: [{ stock_item_id: "rug", qty_ordered: 1200, unit_cost: "1000.50" }],
    });
  });
});

describe("the supplier ledger", () => {
  it("reads statements, invoices, payments and adjustments", () => {
    const out = read(
      "ledger",
      [
        "supplier,type,entry_date,amount,stated_balance,reference,description,paid_on",
        "Hill Mill Yarns,STATEMENT,2026-10-01,,1200.00,,October statement,",
        'Hill Mill Yarns,INVOICE,2026-10-12,"2,816.90",,INV-1019,Yarn,2026-11-14',
        "Hill Mill Yarns,PAYMENT,10/30/2026,1500,,WIRE-7,,",
        "Hill Mill Yarns,ADJUSTMENT,2026-11-01,-25.00,,,Credit note,",
      ].join("\n"),
    );
    expect(out.problems).toEqual([]);
    expect(out.payload).toEqual([
      {
        supplier: "Hill Mill Yarns",
        type: "statement",
        entry_date: "2026-10-01",
        amount: "0.00",
        stated_balance: "1200.00",
        reference: null,
        description: "October statement",
        paid_on: null,
      },
      {
        supplier: "Hill Mill Yarns",
        type: "invoice",
        entry_date: "2026-10-12",
        amount: "2816.90",
        stated_balance: null,
        reference: "INV-1019",
        description: "Yarn",
        paid_on: "2026-11-14T12:00:00.000Z",
      },
      {
        supplier: "Hill Mill Yarns",
        type: "payment",
        entry_date: "2026-10-30",
        amount: "1500.00",
        stated_balance: null,
        reference: "WIRE-7",
        description: "",
        paid_on: null,
      },
      {
        supplier: "Hill Mill Yarns",
        type: "adjustment",
        entry_date: "2026-11-01",
        amount: "-25.00",
        stated_balance: null,
        reference: null,
        description: "Credit note",
        paid_on: null,
      },
    ]);
  });

  it("leaves out entries that don't add up", () => {
    const out = read(
      "ledger",
      [
        "supplier,type,entry_date,amount,stated_balance",
        ",INVOICE,2026-10-12,5,",
        "Hill,REFUND,2026-10-12,5,",
        "Hill,INVOICE,,5,",
        "Hill,INVOICE,2026-10-12,-5,",
        "Hill,PAYMENT,2026-10-12,0,",
        "Hill,STATEMENT,2026-10-12,,",
        "Hill,INVOICE,2028-01-01,5,",
        "Hill,ADJUSTMENT,2026-10-12,abc,",
      ].join("\n"),
    );
    expect(out.payload).toEqual([]);
    expect(out.problems.map((p) => p.reason)).toEqual([
      "This row has no supplier name",
      "“REFUND” should be STATEMENT, INVOICE, PAYMENT or ADJUSTMENT (type)",
      "This row has no date",
      "amount can't be less than zero",
      "A payment needs an amount that isn't zero",
      "A statement needs the balance the supplier says is owed (stated_balance)",
      "2028-01-01 is more than a year from now",
      "“abc” isn't an amount of money (amount)",
    ]);
  });
});

describe("past daily counts", () => {
  it("keeps the days a sum could use, and explains the rest once", () => {
    const out = read(
      "counts",
      [
        "sku,product,date,on_hand",
        "RUG-L,,2026-11-01,0",
        ",Yarn bundle,2026-11-01,14",
        "RUG-L,,2026-11-24,3",
        "RUG-L,,2026-01-01,0",
        "GONE,,2026-11-01,0",
        "GONE,,2026-11-02,0",
        "GONE,,2026-11-03,0",
        "RUG-L,,2026-11-01,5",
        "RUG-L,,2026-11-02,many",
      ].join("\n"),
    );
    expect(out.payload).toEqual([
      { stock_item_id: "rug", day: "2026-11-01", on_hand: 0 },
      { stock_item_id: "yarn", day: "2026-11-01", on_hand: 14 },
    ]);
    expect(out.problems).toEqual([
      { line: 6, reason: "No item in your shop has the SKU “GONE” (and on 2 more rows)" },
      { line: 9, reason: "This item already has a count for this day earlier in the file" },
      { line: 10, reason: "“many” isn't a whole number (the count)" },
    ]);
    expect(out.notes).toEqual([
      "1 row is from more than 200 days ago, further back than any sum looks, and was left out.",
      "1 row is for today or later and was left out: today's count comes from your shop.",
      "A day this app already has a count for keeps the count it has.",
    ]);
  });
});

describe("past deliveries", () => {
  it("reads when goods arrived, and never anything that hasn't happened", () => {
    const out = read(
      "deliveries",
      [
        "reference,sku,quantity,received_at",
        "HI-202603-E5A62F-SEA,RUG-L,12,2026-04-28T14:05:00Z",
        "HI-202603-E5A62F-SEA,RUG-L,12,2026-04-28T14:05:00Z",
        "HI-202603-E5A62F-SEA,RUG-L,0,2026-04-28",
        "HI-202603-E5A62F-SEA,RUG-L,4,2026-12-25",
        ",RUG-L,4,2026-04-28",
        "HI-202603-E5A62F-SEA,NOPE,4,2026-04-28",
        "HI-202603-E5A62F-SEA,RUG-L,4,",
      ].join("\n"),
    );
    expect(out.payload).toEqual([
      {
        reference: "HI-202603-E5A62F-SEA",
        stock_item_id: "rug",
        quantity: 12,
        received_at: "2026-04-28T14:05:00.000Z",
      },
    ]);
    expect(out.problems.map((p) => [p.line, p.reason])).toEqual([
      [3, "The same delivery is already earlier in the file"],
      [4, "how many arrived should be between 1 and 1,000,000, not 0"],
      [5, "2026-12-25 hasn't happened yet"],
      [6, "This row has no order reference, so we can't tell which order it arrived on"],
      [7, "No item in your shop has the SKU “NOPE”"],
      [8, "This row doesn't say when it arrived (received_at)"],
    ]);
    expect(out.notes[0]).toMatch(/history only/);
  });
});

describe("the guide on the import page", () => {
  it("only names columns the readers know, and every column a file must have", async () => {
    const { IMPORT_GUIDE, IMPORT_ORDER } = await import("./guide");
    expect([...IMPORT_ORDER].sort()).toEqual(
      ["counts", "deliveries", "items", "ledger", "orders", "suppliers"].sort(),
    );
    for (const kind of IMPORT_ORDER) {
      const names = IMPORT_GUIDE[kind].columns.map((column) => column.name);
      // A file with exactly the guide's columns is accepted (it may have no usable rows).
      const out = readImport(kind, `${names.join(",")}\n${names.map(() => "x").join(",")}\n`, {
        items: ITEMS,
        today: TODAY,
        now: NOW,
      });
      expect(out.ok, kind).toBe(true);
      // And with any needed column taken away, it is refused by name.
      for (const column of IMPORT_GUIDE[kind].columns.filter((c) => c.needed)) {
        const rest = names.filter(
          (name) => name !== column.name && !(column.name === "sku" && name === "product"),
        );
        const missing = readImport(kind, `${rest.join(",")}\n${rest.map(() => "x").join(",")}\n`, {
          items: ITEMS,
          today: TODAY,
          now: NOW,
        });
        expect(missing.ok, `${kind} without ${column.name}`).toBe(false);
      }
    }
  });
});
