import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import { actionWords, type SortAction } from "@/lib/dashboard/expenses";
import { csvText, expensesTable, type ExpenseExportRow } from "@/lib/dashboard/export";
import { likePattern, monthBounds, parseInboxQuery } from "@/lib/dashboard/inbox";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";

const PAGE = 1000;
const PAGES = 20;

/** The expense list on screen as a spreadsheet: the same view, month and search, every row. */
export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/expenses`);
  const ctx = await getTenantContext(slug, user.id);
  const missing = new NextResponse("Not found", { status: 404 });
  if (!ctx) return missing;
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.dashboard")) return missing;

  const query = parseInboxQuery(Object.fromEntries(new URL(request.url).searchParams));
  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, ctx.tenant.id);
  const lineName = (id: string) =>
    revenue.lines.find((l) => l.id === id)?.name ?? "a line since removed";
  const rows: ExpenseExportRow[] = [];
  for (let page = 0; page < PAGES; page++) {
    let list = supabase
      .from("book_expenses")
      .select("txn_date, amount_cents, account, payee, memo, sort, line_id, split")
      .eq("tenant_id", ctx.tenant.id)
      .is("removed_at", null)
      .eq("is_move", false);
    if (query.view === "to_sort") list = list.is("sort", null);
    if (query.view === "sorted") list = list.not("sort", "is", null).neq("sort", "set_aside");
    if (query.view === "set_aside") list = list.eq("sort", "set_aside");
    if (query.month) {
      const { from, to } = monthBounds(query.month);
      list = list.gte("txn_date", from).lt("txn_date", to);
    }
    if (query.q) list = list.ilike("search_text", likePattern(query.q));
    const { data, error } = await list
      .order("txn_date", { ascending: false })
      .order("id")
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) return new NextResponse("Couldn't read the expenses just now.", { status: 503 });
    const batch = (data ?? []) as Record<string, unknown>[];
    for (const row of batch) {
      const sort = row.sort as SortAction["sort"] | null;
      const action: SortAction | null =
        sort === "line"
          ? { sort, line: String(row.line_id) }
          : sort === "split"
            ? { sort, split: (row.split as Record<string, number>) ?? {} }
            : sort === "shared" || sort === "set_aside"
              ? ({ sort } as SortAction)
              : null;
      rows.push({
        txn_date: String(row.txn_date),
        payee: (row.payee as string | null) ?? null,
        account: (row.account as string | null) ?? null,
        memo: String(row.memo ?? ""),
        amount_cents: Number(row.amount_cents),
        sorted: action ? actionWords(action, lineName) : "Not sorted yet",
      });
    }
    if (batch.length < PAGE) break;
  }
  return new NextResponse(csvText(expensesTable(rows)), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="expenses-${query.view}${query.month ? `-${query.month}` : ""}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
