import type { SupabaseClient } from "@supabase/supabase-js";
import { likePattern } from "@/lib/dashboard/inbox";
import type { RevenueSettings } from "@/lib/dashboard/lines";
import {
  ORDER_LINE_CAP,
  linesOfOrder,
  type OrderQuery,
  type OrderRow,
} from "@/lib/dashboard/orders";
import type { ResolvedRange } from "@/lib/dashboard/range";

/**
 * The orders for a range as the member: one page from the database, or, for
 * one line, up to `ORDER_LINE_CAP` orders filtered here (which line an order
 * touches is the revenue setting, worked out in code) and then paged.
 */
export async function loadOrderList(
  supabase: SupabaseClient,
  tenantId: string,
  revenue: RevenueSettings,
  range: ResolvedRange,
  query: OrderQuery,
  page: { limit: number; offset: number },
): Promise<{ rows: OrderRow[]; total: number; capped: boolean }> {
  const read = async (limit: number, offset: number) => {
    const { data, error } = await supabase.rpc("money_order_list", {
      p_tenant_id: tenantId,
      p_from: range.from.toISOString(),
      p_to: range.to.toISOString(),
      p_status: query.status,
      p_q: query.q ? likePattern(query.q) : null,
      p_limit: limit,
      p_offset: offset,
    });
    if (error) throw new Error(`Could not load orders: ${error.message}`);
    const list = (data as Record<string, unknown>[] | null) ?? [];
    return {
      total: list.length > 0 ? Number(list[0].total_count) : 0,
      rows: list.map((r): OrderRow => ({
        id: String(r.id),
        name: (r.name as string | null) ?? null,
        processed_at: String(r.processed_at),
        financial_status: (r.financial_status as string | null) ?? null,
        tags: (r.tags as string[] | null) ?? [],
        net_sales: r.net_sales as string,
        total: r.total as string,
        items: Array.isArray(r.items) ? (r.items as OrderRow["items"]) : [],
      })),
    };
  };
  if (!query.line) {
    const { rows, total } = await read(page.limit, page.offset);
    return { rows, total, capped: false };
  }
  const all: OrderRow[] = [];
  let total = 0;
  for (let offset = 0; offset < ORDER_LINE_CAP; offset += 1000) {
    const batch = await read(1000, offset);
    total = batch.total;
    all.push(...batch.rows);
    if (batch.rows.length < 1000) break;
  }
  const mine = all.filter((o) => linesOfOrder(revenue, o).some((l) => l.id === query.line));
  return {
    rows: mine.slice(page.offset, page.offset + page.limit),
    total: mine.length,
    capped: total > ORDER_LINE_CAP,
  };
}
