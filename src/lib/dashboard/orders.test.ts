import { describe, expect, it } from "vitest";
import { revenueSettingsSchema } from "./lines";
import {
  linesOfOrder,
  orderCents,
  orderHref,
  ordersTable,
  parseOrderQuery,
  type OrderRow,
} from "./orders";

const settings = revenueSettingsSchema.parse({
  version: 1,
  lines: [
    { id: "shop", name: "Shop" },
    { id: "classes", name: "Classes" },
  ],
  default_line: "shop",
  rules: [{ id: "w", match: "workshop", line: "classes" }],
});

const order = (over: Partial<OrderRow> = {}): OrderRow => ({
  id: "o1",
  name: "#1042",
  processed_at: "2026-11-03T15:00:00Z",
  financial_status: "PAID",
  tags: ["gift"],
  net_sales: "120.00",
  total: "131.50",
  items: [
    { product_tags: [], product_type: "Yarn", workshop: false },
    { product_tags: [], product_type: null, workshop: true },
  ],
  ...over,
});

describe("the order list", () => {
  it("names every line an order's items fall in, in the lines' order", () => {
    expect(linesOfOrder(settings, order()).map((l) => l.name)).toEqual(["Shop", "Classes"]);
    expect(linesOfOrder(settings, order({ items: [] })).map((l) => l.name)).toEqual(["Shop"]);
    expect(orderCents(settings, order())).toBe(12000);
    expect(
      orderCents({ ...settings, figure: "order_totals" }, order({ financial_status: "REFUNDED" })),
    ).toBe(0);
  });

  it("keeps its filters in the address, the range with them", () => {
    const q = parseOrderQuery({ status: "refunded", line: "classes", q: " #10 ", page: "2" });
    expect(q).toEqual({ status: "REFUNDED", line: "classes", q: "#10", page: 2 });
    expect(orderHref("/o", "last_month", q, { page: 1 })).toBe(
      "/o?range=last_month&status=refunded&line=classes&q=%2310",
    );
    expect(parseOrderQuery({ status: "sold" }).status).toBeNull();
  });

  it("downloads as a spreadsheet", () => {
    expect(ordersTable(settings, [order()], () => "2026-11-03")).toEqual([
      ["Date", "Order", "Payment", "Lines", "Tags", "Revenue"],
      ["2026-11-03", "#1042", "Paid", "Shop; Classes", "gift", 120],
    ]);
  });
});
