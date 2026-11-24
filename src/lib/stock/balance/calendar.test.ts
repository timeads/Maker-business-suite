import { describe, expect, it } from "vitest";
import type { AgingResult, OpenBill } from "./aging";
import { amountWords, billEvents, payDay, toIcs } from "./calendar";

// TuftStock's cases (vendor-account/calendar.test.ts), with made-up suppliers.
const bill = (
  reference: string,
  date: string,
  dueDate: string,
  open: string,
  amount = open,
): OpenBill => ({
  id: reference,
  reference,
  date,
  amount,
  open,
  partial: open !== amount,
  ageDays: 0,
  dueDate,
  daysPastDue: 0,
});
const aging = (bills: OpenBill[]): AgingResult =>
  ({
    termsDays: 30,
    openTotal: "0",
    unattributed: "0",
    bills,
    buckets: {},
  }) as unknown as AgingResult;

describe("payDay", () => {
  it("moves a Saturday or Sunday due date back to Friday; weekdays stay", () => {
    expect(payDay("2026-11-21")).toBe("2026-11-20"); // Sat → Fri
    expect(payDay("2026-11-22")).toBe("2026-11-20"); // Sun → Fri
    expect(payDay("2026-11-19")).toBe("2026-11-19"); // Thu
    expect(payDay("2026-11-01")).toBe("2026-10-30"); // Sun, across a month
  });
});

describe("amountWords", () => {
  it("writes exact amounts with commas", () => {
    expect(amountWords("1922.87")).toBe("1,922.87");
    expect(amountWords("545.4")).toBe("545.40");
    expect(amountWords("1234567")).toBe("1,234,567.00");
  });
});

describe("billEvents", () => {
  const accounts = [
    {
      supplierId: "mill",
      supplierName: "Hill Mill",
      aging: aging([
        bill("HM-1008", "2026-10-18", "2026-11-17", "1922.87"),
        bill("HM-1016", "2026-10-20", "2026-11-19", "898.40"),
        bill("HM-1019", "2026-10-25", "2026-11-24", "2816.90"),
      ]),
    },
    {
      supplierId: "dye",
      supplierName: "Dye Works",
      aging: aging([bill("162320", "2026-10-20", "2026-11-19", "1175.89")]),
    },
    {
      supplierId: "loom",
      supplierName: "Loom & Co",
      aging: aging([
        bill("70172", "2026-10-14", "2026-11-13", "545.39"),
        bill("70200", "2026-10-27", "2026-11-26", "482.53"),
        bill("70201", "2026-10-27", "2026-11-26", "546.36"),
      ]),
    },
  ];
  const events = billEvents(accounts, "2026-11-05");

  it("makes one event per supplier per pay day, soonest first, with exact totals", () => {
    expect(events.map((e) => [e.date, e.title])).toEqual([
      ["2026-11-13", "Loom & Co due - $545.39"],
      ["2026-11-17", "Hill Mill due - $1,922.87"],
      ["2026-11-19", "Dye Works due - $1,175.89"],
      ["2026-11-19", "Hill Mill due - $898.40"],
      ["2026-11-24", "Hill Mill due - $2,816.90"],
      ["2026-11-26", "Loom & Co due - $1,028.89"],
    ]);
  });

  it("lists each invoice inside the event, with a stable key", () => {
    const last = events.at(-1)!;
    expect(last.key).toBe("loom:2026-11-26");
    expect(last.description).toContain("70200 · $482.53 (invoiced Oct 27)");
    expect(last.description).toContain("70201 · $546.36 (invoiced Oct 27)");
    expect(last.description).toContain("Due Thu Nov 26 (30 days from the invoice date)");
  });

  it("puts a weekend bill on the Friday before and says why", () => {
    const [ev] = billEvents(
      [
        {
          supplierId: "loom",
          supplierName: "Loom & Co",
          aging: aging([bill("1", "2026-10-22", "2026-11-21", "100.00")]),
        },
      ],
      "2026-11-05",
    );
    expect(ev).toMatchObject({ date: "2026-11-20", key: "loom:2026-11-20" });
    expect(ev.description).toContain("Due Sat Nov 21: on the Friday before");
  });

  it("shows what's still owed on a part-paid bill, in the workspace's own currency", () => {
    const [ev] = billEvents(
      [
        {
          supplierId: "m",
          supplierName: "Hill Mill",
          aging: aging([bill("HM-1", "2026-10-18", "2026-11-17", "500.00", "1922.87")]),
        },
      ],
      "2026-11-05",
      (amount) => `£${amountWords(amount)}`,
    );
    expect(ev.title).toBe("Hill Mill due - £500.00");
    expect(ev.description).toContain("HM-1 · £500.00 still owed of £1,922.87");
  });

  it("a bill ticked “Paid” leaves the amount; when all of a day's bills are ticked the event says so", () => {
    const paid = {
      ...bill("70201", "2026-10-27", "2026-11-26", "546.36"),
      paymentSentAt: "2026-11-13T15:00:00Z",
    };
    const [some] = billEvents(
      [
        {
          supplierId: "l",
          supplierName: "Loom & Co",
          aging: aging([paid, bill("70200", "2026-10-27", "2026-11-26", "482.53")]),
        },
      ],
      "2026-11-16",
    );
    expect(some.title).toBe("Loom & Co due - $482.53");
    expect(some.description).toContain(
      "70201 · $546.36 (invoiced Oct 27), paid Nov 13, waiting to show up",
    );
    const [all] = billEvents(
      [
        {
          supplierId: "l",
          supplierName: "Loom & Co",
          aging: aging([
            {
              ...bill("70172", "2026-10-14", "2026-11-13", "545.39"),
              paymentSentAt: "2026-11-13T15:00:00Z",
            },
          ]),
        },
      ],
      "2026-11-16",
    );
    expect(all).toMatchObject({ title: "Paid · Loom & Co due - $545.39", overdue: false });
  });

  it("flags a bill past its due date", () => {
    const [ev] = billEvents(
      [
        {
          supplierId: "d",
          supplierName: "Dye Works",
          aging: aging([bill("1", "2026-10-01", "2026-10-31", "10.00")]),
        },
      ],
      "2026-11-05",
    );
    expect(ev).toMatchObject({
      overdue: true,
      date: "2026-10-30",
      title: "PAST DUE · Dye Works due - $10.00",
    });
  });

  it("writes the events as a calendar file a calendar can take, and take again", () => {
    const file = toIcs(events.slice(0, 1), {
      name: "Bills; to pay",
      stamp: new Date("2026-11-05T14:30:00Z"),
      host: "example.test",
    });
    expect(file.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(file.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(file).toContain("X-WR-CALNAME:Bills\; to pay");
    expect(file).toContain("UID:bill-loom-2026-11-13@example.test");
    expect(file).toContain("DTSTAMP:20261105T143000Z");
    expect(file).toContain("DTSTART;VALUE=DATE:20261113");
    expect(file).toContain("DTEND;VALUE=DATE:20261114");
    expect(file).toContain("SUMMARY:Loom & Co due - $545.39");
    // Line breaks inside the notes are escaped, and no line runs past 75 bytes.
    expect(file).toContain("\\n");
    for (const line of file.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });
});
