import { Money } from "../balance/money";

/**
 * What an order comes to (ported from TuftStock's src/lib/po/totals.ts):
 * total = line subtotal + shipping + tax + adjustments, where
 * tax = subtotal × taxRatePct%. Everything is whole cents: money never goes
 * through floating-point arithmetic. Worked out on read, never stored.
 */

type Num = Money.Value;

export interface PoLineForTotal {
  qtyOrdered: number;
  unitCost: Num;
}

export interface PoTotalsInput {
  lines: PoLineForTotal[];
  shippingCost: Num;
  taxRatePct: Num; // applied to line subtotal
  adjustments: { amount: Num }[]; // signed
}

export interface PoTotals {
  subtotal: Money;
  shipping: Money;
  tax: Money;
  adjustmentsTotal: Money;
  total: Money;
}

/** Whole cents as Money, built from text so no division is involved. */
export function fromCents(cents: number): Money {
  const abs = Math.abs(Math.trunc(cents));
  return new Money(
    `${cents < 0 ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`,
  );
}

/** One line's value: unit cost × quantity, in whole cents. */
export function lineTotal(line: PoLineForTotal): Money {
  return fromCents(new Money(line.unitCost).cents * Math.max(0, Math.trunc(line.qtyOrdered)));
}

/** A percentage with up to three decimals, as thousandths of a percent ("8.875" -> 8875). */
function milliPercent(value: Num): number {
  const text = (value instanceof Money ? value.toFixed(2) : String(value)).trim();
  const match = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!match || (match[1] === "" && !match[2])) return 0;
  return Number(match[1] || "0") * 1000 + Number((match[2] ?? "").padEnd(3, "0").slice(0, 3));
}

export function computePoTotals(input: PoTotalsInput): PoTotals {
  const subtotal = input.lines.reduce((sum, l) => sum.add(lineTotal(l)), new Money(0));
  const shipping = new Money(input.shippingCost);
  // subtotal cents × thousandths of a percent ÷ 100,000, rounded half up to
  // the cent. BigInt keeps the product exact however large the order.
  const scaled = BigInt(subtotal.cents) * BigInt(milliPercent(input.taxRatePct));
  const tax = fromCents(Number((scaled + BigInt(50_000)) / BigInt(100_000)));
  const adjustmentsTotal = input.adjustments.reduce((sum, a) => sum.add(a.amount), new Money(0));
  const total = subtotal.add(shipping).add(tax).add(adjustmentsTotal);
  return { subtotal, shipping, tax, adjustmentsTotal, total };
}

export interface PoLineForOutstanding {
  qtyOrdered: number;
  qtyReceived: number;
}

/**
 * Units still owed on an order: Σ max(0, qtyOrdered − qtyReceived). Over-received
 * lines clamp at 0 (same rule as `computeOnOrder`), so an order that got MORE than
 * ordered counts as fully received.
 */
export function outstandingUnits(lines: PoLineForOutstanding[]): number {
  return lines.reduce((sum, l) => sum + Math.max(0, l.qtyOrdered - l.qtyReceived), 0);
}

/** The named adjustments stored on an order, read defensively. */
export function parseAdjustments(value: unknown): { label: string; amount: string }[] {
  if (!Array.isArray(value)) return [];
  const out: { label: string; amount: string }[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { label, amount } = entry as { label?: unknown; amount?: unknown };
    if (typeof label !== "string" || !label.trim()) continue;
    try {
      out.push({
        label: label.trim().slice(0, 80),
        amount: new Money(amount as Money.Value).toFixed(2),
      });
    } catch {
      // Not an amount: leave it out.
    }
  }
  return out;
}
