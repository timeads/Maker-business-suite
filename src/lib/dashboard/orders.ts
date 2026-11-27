import { amount } from "./export";
import { factsOf, lineFor, orderRevenueCents, type RevenueSettings } from "./lines";

/**
 * Money → Orders: the shop's orders for a range, each with the business
 * lines its items fall in (the revenue setting's rules, as everywhere in
 * Money), filtered by payment status and line and searched by number or
 * tag, everything in the address. Pure.
 */

export const ORDER_PAGE = 50;
/** The most orders read for a line filter, which is worked out after reading. */
export const ORDER_LINE_CAP = 2000;

export const PAYMENT_STATUSES = [
  "PAID",
  "PARTIALLY_REFUNDED",
  "PARTIALLY_PAID",
  "PENDING",
  "AUTHORIZED",
  "REFUNDED",
  "VOIDED",
] as const;

export const PAYMENT_WORDS: Record<string, string> = {
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Partly refunded",
  PARTIALLY_PAID: "Partly paid",
  PENDING: "Waiting for payment",
  AUTHORIZED: "Authorised",
  REFUNDED: "Refunded",
  VOIDED: "Voided",
};

export const paymentWords = (status: string | null) =>
  status ? (PAYMENT_WORDS[status.toUpperCase()] ?? status.toLowerCase()) : "Not known";

export type OrderQuery = { status: string | null; line: string | null; q: string; page: number };

const first = (value: string | string[] | undefined) =>
  Array.isArray(value) ? value[0] : (value ?? "");

export function parseOrderQuery(params: Record<string, string | string[] | undefined>): OrderQuery {
  const status = first(params.status).toUpperCase();
  const line = first(params.line);
  const page = Number.parseInt(first(params.page), 10);
  return {
    status: (PAYMENT_STATUSES as readonly string[]).includes(status) ? status : null,
    line: /^[a-z0-9-]{1,40}$/.test(line) ? line : null,
    q: first(params.q).trim().replace(/\s+/g, " ").slice(0, 80),
    page: Number.isFinite(page) && page > 0 && page <= 1000 ? page : 1,
  };
}

/** The list's address with some of its query changed; the range is kept as it is. */
export function orderHref(
  base: string,
  range: string,
  query: OrderQuery,
  change: Partial<OrderQuery>,
): string {
  const next = { ...query, page: 1, ...change };
  const params = new URLSearchParams({ range });
  if (next.status) params.set("status", next.status.toLowerCase());
  if (next.line) params.set("line", next.line);
  if (next.q) params.set("q", next.q);
  if (next.page > 1) params.set("page", String(next.page));
  return `${base}?${params}`;
}

export type OrderRow = {
  id: string;
  name: string | null;
  processed_at: string;
  financial_status: string | null;
  tags: string[];
  net_sales: number | string;
  total: number | string;
  items: { product_tags: string[] | null; product_type: string | null; workshop: boolean }[];
};

/** The lines an order's items fall in, in the order the lines are set up; none without lines. */
export function linesOfOrder(settings: RevenueSettings, order: Pick<OrderRow, "tags" | "items">) {
  const facts = (order.items.length > 0 ? order.items : [null]).map((item) =>
    factsOf({
      order_tags: order.tags,
      product_tags: item?.product_tags ?? null,
      product_type: item?.product_type ?? null,
      workshop: item?.workshop ?? false,
    }),
  );
  const found = new Set(facts.map((f) => lineFor(settings, f)).filter((id): id is string => !!id));
  return settings.lines.filter((l) => found.has(l.id));
}

/** What an order counts as revenue under the workspace's figure, whole cents. */
export const orderCents = (settings: RevenueSettings, order: OrderRow) =>
  orderRevenueCents(
    {
      net_sales: order.net_sales,
      total: order.total,
      cancelled: false,
      is_test: false,
      financial_status: order.financial_status,
    },
    settings.figure,
  );

/** The list as spreadsheet rows, the heading first. */
export function ordersTable(
  settings: RevenueSettings,
  rows: readonly OrderRow[],
  day: (iso: string) => string,
): (string | number | null)[][] {
  return [
    ["Date", "Order", "Payment", "Lines", "Tags", "Revenue"],
    ...rows.map((o) => [
      day(o.processed_at),
      o.name ?? "",
      paymentWords(o.financial_status),
      linesOfOrder(settings, o)
        .map((l) => l.name)
        .join("; "),
      o.tags.join("; "),
      amount(orderCents(settings, o)),
    ]),
  ];
}
