import { describe, expect, it } from "vitest";
import { summarizeIncoming, type IncomingOrderInput } from "./incoming";

const order = (over: Partial<IncomingOrderInput>): IncomingOrderInput => ({
  id: "po1",
  number: 1,
  supplierName: "Hill Mill",
  status: "ordered",
  orderedOn: "2026-10-01",
  expectedOn: "2026-10-20",
  lines: [{ qtyOrdered: 36, qtyReceived: 0 }],
  shipments: [],
  ...over,
});
const parcel = (over: Partial<IncomingOrderInput["shipments"][number]> = {}) => ({
  id: "s1",
  carrier: "UPS",
  tracking: "1Z999",
  expectedOn: null,
  arrivedOn: null,
  ...over,
});
const TODAY = "2026-10-05";

describe("summarizeIncoming", () => {
  it("ordered, not shipped: the order's expected date", () => {
    expect(summarizeIncoming([order({})], TODAY)).toEqual([
      {
        id: "po1",
        number: 1,
        supplierName: "Hill Mill",
        units: 36,
        stage: "ordered",
        expected: "2026-10-20",
        late: false,
        daysLate: 0,
        orderedOn: "2026-10-01",
        shipments: [],
      },
    ]);
  });

  it("shipped: the parcel's date wins over the order's", () => {
    const [r] = summarizeIncoming(
      [order({ shipments: [parcel({ expectedOn: "2026-10-09" })] })],
      TODAY,
    );
    expect(r).toMatchObject({ stage: "shipped", expected: "2026-10-09" });
    // No date on the parcel: fall back to the order's.
    const [s] = summarizeIncoming([order({ shipments: [parcel()] })], TODAY);
    expect(s).toMatchObject({ stage: "shipped", expected: "2026-10-20" });
  });

  it("arrived but not checked in yet: arrived, no date, never late", () => {
    const [r] = summarizeIncoming(
      [
        order({
          expectedOn: "2026-09-01",
          shipments: [parcel({ arrivedOn: "2026-10-04" })],
        }),
      ],
      TODAY,
    );
    expect(r).toMatchObject({ stage: "arrived", expected: null, late: false });
  });

  it("counts only what's outstanding, and skips drafts, finished and fully-received orders", () => {
    const rows = summarizeIncoming(
      [
        order({ status: "partial", lines: [{ qtyOrdered: 36, qtyReceived: 12 }] }),
        order({ id: "po2", number: 2, status: "draft" }),
        order({ id: "po3", number: 3, status: "closed" }),
        order({ id: "po4", number: 4, lines: [{ qtyOrdered: 36, qtyReceived: 40 }] }),
      ],
      TODAY,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ number: 1, units: 24 });
  });

  it("flags a past expected date as late, and says by how much", () => {
    const [r] = summarizeIncoming([order({ expectedOn: "2026-09-30" })], TODAY);
    expect(r).toMatchObject({ expected: "2026-09-30", late: true, daysLate: 5 });
    // Due today isn't late yet.
    expect(summarizeIncoming([order({ expectedOn: TODAY })], TODAY)[0].late).toBe(false);
  });

  it("lists the oldest expected first, with undated orders last", () => {
    const rows = summarizeIncoming(
      [
        order({ id: "a", number: 1, expectedOn: null }),
        order({ id: "b", number: 2, expectedOn: "2026-10-20" }),
        order({ id: "c", number: 3, expectedOn: "2026-09-28" }),
        order({
          id: "d",
          number: 4,
          shipments: [parcel({ expectedOn: "2026-10-07" }), parcel({ id: "s2", arrivedOn: "2026-10-02" })],
        }),
      ],
      TODAY,
    );
    expect(rows.map((r) => r.number)).toEqual([3, 4, 2, 1]);
  });
});
