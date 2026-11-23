import { Money } from "./balance/money";
import { fromCents } from "./po/totals";

/**
 * What has been spent with suppliers (ported from TuftStock's
 * src/lib/spend/aggregate.ts; pure, no I/O). "Spend" is the ordered value of
 * an order line (quantity × cost each) on orders that have been placed, dated
 * by when the order was sent. Shipping, tax and adjustments belong to the
 * whole order and are left out, so the item and supplier breakdowns add up
 * to the same total.
 */

export interface SpendLineInput {
  poId: string;
  date: Date; // when the order was sent (else created)
  supplierId: string;
  supplierName: string;
  sku: string | null;
  title: string;
  qtyOrdered: number;
  unitCost: Money.Value;
}

export interface SkuSpend {
  sku: string | null;
  title: string;
  supplierName: string; // supplier of the most recent order for this item
  units: number;
  spend: string;
  poCount: number;
  lastOrdered: string; // ISO
}

export interface VendorSpend {
  supplierId: string;
  supplierName: string;
  units: number;
  spend: string;
  poCount: number;
  skuCount: number;
}

export interface MonthSpend {
  month: string; // "YYYY-MM"
  spend: string;
}

export interface SpendResult {
  total: string;
  poCount: number;
  lineCount: number;
  bySku: SkuSpend[];
  byVendor: VendorSpend[];
  byMonth: MonthSpend[];
}

/** Aggregate spend from order lines, keeping only those on/after `since` (null = all time). */
export function aggregateSpend(lines: SpendLineInput[], since: Date | null): SpendResult {
  let total = new Money(0);
  const allPos = new Set<string>();
  let lineCount = 0;

  interface SkuAcc {
    sku: string | null;
    title: string;
    supplierName: string;
    lastDate: Date;
    units: number;
    spend: Money;
    pos: Set<string>;
  }
  interface VenAcc {
    supplierId: string;
    supplierName: string;
    units: number;
    spend: Money;
    pos: Set<string>;
    skus: Set<string>;
  }
  const skuMap = new Map<string, SkuAcc>();
  const venMap = new Map<string, VenAcc>();
  const monthMap = new Map<string, Money>();

  for (const l of lines) {
    if (since && l.date < since) continue;
    const amount = fromCents(new Money(l.unitCost).cents * l.qtyOrdered);
    total = total.add(amount);
    allPos.add(l.poId);
    lineCount++;

    const skuKey = l.sku ?? `title:${l.title}`;
    let s = skuMap.get(skuKey);
    if (!s) {
      s = {
        sku: l.sku,
        title: l.title,
        supplierName: l.supplierName,
        lastDate: l.date,
        units: 0,
        spend: new Money(0),
        pos: new Set(),
      };
      skuMap.set(skuKey, s);
    }
    s.units += l.qtyOrdered;
    s.spend = s.spend.add(amount);
    s.pos.add(l.poId);
    if (l.date >= s.lastDate) {
      s.lastDate = l.date;
      s.supplierName = l.supplierName;
      s.title = l.title;
    }

    let v = venMap.get(l.supplierId);
    if (!v) {
      v = {
        supplierId: l.supplierId,
        supplierName: l.supplierName,
        units: 0,
        spend: new Money(0),
        pos: new Set(),
        skus: new Set(),
      };
      venMap.set(l.supplierId, v);
    }
    v.units += l.qtyOrdered;
    v.spend = v.spend.add(amount);
    v.pos.add(l.poId);
    v.skus.add(skuKey);

    const mk = l.date.toISOString().slice(0, 7);
    monthMap.set(mk, (monthMap.get(mk) ?? new Money(0)).add(amount));
  }

  const bySku = [...skuMap.values()]
    .sort((a, b) => b.spend.cents - a.spend.cents)
    .map((s) => ({
      sku: s.sku,
      title: s.title,
      supplierName: s.supplierName,
      units: s.units,
      spend: s.spend.toFixed(2),
      poCount: s.pos.size,
      lastOrdered: s.lastDate.toISOString(),
    }));

  const byVendor = [...venMap.values()]
    .sort((a, b) => b.spend.cents - a.spend.cents)
    .map((v) => ({
      supplierId: v.supplierId,
      supplierName: v.supplierName,
      units: v.units,
      spend: v.spend.toFixed(2),
      poCount: v.pos.size,
      skuCount: v.skus.size,
    }));

  const byMonth = [...monthMap.entries()]
    .map(([month, spend]) => ({ month, spend: spend.toFixed(2) }))
    .sort((a, b) => a.month.localeCompare(b.month));

  return { total: total.toFixed(2), poCount: allPos.size, lineCount, bySku, byVendor, byMonth };
}

/** The first day `months` months before `today` (a UTC-midnight date), as the range's start. */
export function monthsBefore(today: Date, months: number): Date {
  const d = new Date(today.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}
