import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { csvCell } from "@/lib/bookings/emails";
import { getEntitlements } from "@/lib/entitlements";
import {
  COLUMNS,
  DEFAULT_HIDDEN_COLUMNS,
  DEFAULT_SORT,
  csvTable,
  isColumnKey,
  isViewKey,
  searchRows,
  sortRows,
  viewRows,
} from "@/lib/stock/views";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { loadStock } from "../../data";

/**
 * The view on screen as a spreadsheet file: the same filter, search, order
 * and columns as the grid, and every row of it (not just the page showing).
 */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/stock/items`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.stock")) return missing;

  const query = new URL(request.url).searchParams;
  const show = query.get("show");
  const view = isViewKey(show) ? show : "all";
  const sortKey = query.get("sort");
  const sort = isColumnKey(sortKey)
    ? { key: sortKey, dir: query.get("dir") === "desc" ? ("desc" as const) : ("asc" as const) }
    : DEFAULT_SORT;
  const asked = (query.get("cols") ?? "").split(",").filter(isColumnKey);
  const columns =
    asked.length > 0
      ? asked
      : COLUMNS.map((column) => column.key).filter((key) => !DEFAULT_HIDDEN_COLUMNS.includes(key));

  const { rows, today } = await loadStock(await createClient(), ctx.tenant);
  // "Export the ticked rows": the page sends their ids; none means the whole view.
  const only = new Set(
    (query.get("ids") ?? "").split(",").filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
  );
  const shown = sortRows(
    searchRows(viewRows(rows, today)[view], (query.get("q") ?? "").slice(0, 80)),
    sort.key,
    sort.dir,
  ).filter((row) => only.size === 0 || only.has(row.item.id));
  const table = csvTable(shown, columns);
  return new NextResponse(table.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n", {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="stock-${view}-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
