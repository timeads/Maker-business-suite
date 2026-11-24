import { Money } from "../balance/money";
import { computePoTotals, lineTotal, parseAdjustments } from "./totals";

/**
 * A purchase order as the supplier receives it: every word and figure that
 * goes on the page, worked out here so the page itself only lays them out.
 * Pure: dates come in as stored and go out in the workspace's own timezone,
 * money stays in whole cents (`totals.ts`) until it is written down.
 */

export type PoDocumentInput = {
  business: { name: string; addressLines: string[] };
  order: {
    number: number;
    /** The order's name, e.g. KE-202611-A7A950; the plain number is used without one. */
    reference?: string | null;
    status: string;
    /** Timestamps as stored (UTC); `expectedOn` is a plain day. */
    createdAt: string;
    orderedAt: string | null;
    expectedOn: string | null;
    notes: string;
    shippingCost: string | number;
    taxRatePct: string | number;
    adjustments: unknown;
  };
  supplier: {
    name: string;
    contactName: string | null;
    email: string | null;
    moreEmails: string[];
    moq: number;
    moqAppliesTo: "order" | "sku";
  };
  lines: {
    sku: string | null;
    supplierSku: string | null;
    title: string;
    variantTitle: string | null;
    /** The item's own smallest order, when it has one. */
    moq: number | null;
    qty: number;
    unitCost: string | number;
  }[];
  timezone: string;
  currency: string;
};

export type PoDocument = {
  title: string;
  business: { name: string; addressLines: string[] };
  number: string;
  status: string;
  supplier: { name: string; contact: string | null; emails: string | null };
  dates: { created: string; sent: string; expected: string };
  lines: {
    sku: string;
    supplierSku: string;
    item: string;
    moq: string;
    qty: string;
    unit: string;
    total: string;
  }[];
  totals: { label: string; value: string; strong?: boolean }[];
  notes: string | null;
};

const NONE = "—";

/** What the supplier reads, not our own words for where an order stands. */
const STATUS_WORDS: Record<string, string> = {
  draft: "Draft",
  ordered: "Ordered",
  partial: "Part received",
  closed: "Received",
  cancelled: "Cancelled",
};

/** "Nov 17, 2026" for a moment in time, on the workspace's own calendar. */
export function poDate(value: string | null, timezone: string): string {
  if (!value) return NONE;
  // A plain day has no time of day to shift: read it at noon UTC and say it in UTC.
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const date = new Date(plain ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return NONE;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: plain ? "UTC" : timezone,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

/** "1,200.00" from whole cents: grouped by hand, so no float ever holds the amount. */
export function plainAmount(money: Money): string {
  const [whole, cents] = money.toFixed(2).replace("-", "").split(".");
  return `${money.isNegative() ? "-" : ""}${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${cents}`;
}

/** "$5,818.00", "€12.00", or "5,818.00 XYZ" for a currency with no sign we know. */
export function currencyAmount(money: Money, currency: string): string {
  let sign: string | null = null;
  try {
    sign =
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        currencyDisplay: "narrowSymbol",
      })
        .formatToParts(0)
        .find((part) => part.type === "currency")?.value ?? null;
  } catch {
    sign = null;
  }
  const amount = plainAmount(money);
  if (!sign || sign === currency) return `${amount} ${currency}`;
  return amount.startsWith("-") ? `-${sign}${amount.slice(1)}` : `${sign}${amount}`;
}

/** "8.875" → "8.875", "0" → "0.00", "7.5" → "7.50": the rate as it was typed, at least two places. */
const rateText = (value: string | number) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  const text = String(n);
  const places = text.includes(".") ? text.split(".")[1].length : 0;
  return places >= 2 ? text : n.toFixed(2);
};

export function buildPoDocument(input: PoDocumentInput): PoDocument {
  const lines = input.lines.filter((line) => line.qty > 0);
  const priced = lines.map((line) => ({
    qtyOrdered: line.qty,
    unitCost: new Money(Number(line.unitCost).toFixed(2)),
  }));
  const totals = computePoTotals({
    lines: priced,
    shippingCost: String(input.order.shippingCost ?? "0"),
    taxRatePct: String(input.order.taxRatePct ?? "0"),
    adjustments: parseAdjustments(input.order.adjustments),
  });
  const money = (value: Money) => currencyAmount(value, input.currency);
  const emails = [input.supplier.email, ...input.supplier.moreEmails].filter(
    (email): email is string => Boolean(email),
  );
  const reference = input.order.reference?.trim() || null;
  return {
    title: `Purchase order ${reference ?? input.order.number}`,
    business: {
      name: input.business.name,
      addressLines: input.business.addressLines.map((line) => line.trim()).filter(Boolean),
    },
    number: reference ?? `No. ${input.order.number}`,
    status: STATUS_WORDS[input.order.status] ?? input.order.status,
    supplier: {
      name: input.supplier.name,
      contact: input.supplier.contactName?.trim() || null,
      emails: emails.length > 0 ? [...new Set(emails)].join(", ") : null,
    },
    dates: {
      created: poDate(input.order.createdAt, input.timezone),
      sent: poDate(input.order.orderedAt, input.timezone),
      expected: poDate(input.order.expectedOn, input.timezone),
    },
    lines: lines.map((line, index) => {
      // The item's own smallest order, else the supplier's when it counts per item.
      const moq =
        line.moq ??
        (input.supplier.moqAppliesTo === "sku" && input.supplier.moq > 1
          ? input.supplier.moq
          : null);
      return {
        sku: line.sku?.trim() || NONE,
        supplierSku: line.supplierSku?.trim() || NONE,
        item: line.variantTitle ? `${line.title} — ${line.variantTitle}` : line.title,
        moq: moq == null ? NONE : String(moq),
        qty: String(line.qty),
        unit: plainAmount(priced[index].unitCost),
        total: plainAmount(lineTotal(priced[index])),
      };
    }),
    totals: [
      { label: "Subtotal", value: money(totals.subtotal) },
      { label: "Shipping", value: money(totals.shipping) },
      { label: `Tax (${rateText(input.order.taxRatePct)}%)`, value: money(totals.tax) },
      { label: "Adjustments", value: money(totals.adjustmentsTotal) },
      { label: "Total", value: money(totals.total), strong: true },
    ],
    notes: input.order.notes.trim() || null,
  };
}
