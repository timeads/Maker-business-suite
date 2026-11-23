import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_SORT,
  VIEWS,
  VIEW_NOTES,
  isColumnKey,
  isViewKey,
  searchRows,
  sortRows,
  toGridRow,
  viewRows,
} from "@/lib/stock/views";
import { cn } from "@/lib/utils";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../data";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";
import { ItemsGrid } from "./grid";

export const metadata: Metadata = { title: "Everything in stock" };

const PER_PAGE = 250;

export default async function StockItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ show?: string; q?: string; sort?: string; dir?: string; page?: string }>;
}) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/items`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const query = await searchParams;
  const show = isViewKey(query.show) ? query.show : "all";
  const q = (query.q ?? "").trim().slice(0, 80);
  const sort = isColumnKey(query.sort)
    ? { key: query.sort, dir: query.dir === "desc" ? ("desc" as const) : ("asc" as const) }
    : DEFAULT_SORT;
  const base = `/w/${tenant.slug}/stock`;

  const { rows, suppliers, today } = await loadStock(await createClient(), tenant);
  const views = viewRows(rows, today);
  const shown = sortRows(searchRows(views[show], q), sort.key, sort.dir);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1));
  const onPage = shown.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // The view and search, carried by the sort links, the page links and the download.
  const keep = new URLSearchParams();
  if (show !== "all") keep.set("show", show);
  if (q) keep.set("q", q);
  const pageHref = (n: number) => {
    const search = new URLSearchParams(keep);
    if (sort !== DEFAULT_SORT) {
      search.set("sort", sort.key);
      search.set("dir", sort.dir);
    }
    if (n > 1) search.set("page", String(n));
    const text = search.toString();
    return `${base}/items${text ? `?${text}` : ""}`;
  };

  return (
    <>
      <PageHeader
        title="Stock"
        description="Every item your shop keeps a count of. Tick the ones you want and draft an order for them."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />

      <div className="flex flex-col gap-3 print:hidden">
        <nav aria-label="Views" className="flex flex-wrap gap-1">
          {VIEWS.map(([key, label]) => (
            <Link
              key={key}
              href={`${base}/items${key === "all" ? "" : `?show=${key}`}`}
              aria-current={show === key ? "page" : undefined}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150",
                show === key ? "bg-teal font-semibold text-white" : "text-text-2 hover:bg-hover",
              )}
            >
              {label} <span className="tabular-nums opacity-80">{views[key].length}</span>
            </Link>
          ))}
        </nav>
        {VIEW_NOTES[show] && (
          <p className="text-muted-foreground font-read text-sm">{VIEW_NOTES[show]}</p>
        )}
        <form role="search" className="max-w-sm">
          {show !== "all" && <input type="hidden" name="show" value={show} />}
          <Input
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search by name, SKU or supplier"
            aria-label="Search items"
          />
        </form>
      </div>

      {onPage.length === 0 ? (
        <p className="text-muted-foreground border-border bg-card rounded-xl border p-5 text-sm">
          {rows.length === 0
            ? "Your shop's items appear here after the next sync."
            : show === "hidden" && !q
              ? "Nothing is left out. To stop reordering something, tick it under All and press “Don't reorder”."
              : "Nothing matches."}
        </p>
      ) : (
        <ItemsGrid
          slug={tenant.slug}
          rows={onPage.map((row) => toGridRow(row, today))}
          canEdit={canEdit}
          suppliers={suppliers
            .filter((s) => !s.archived_at)
            .map((s) => ({ id: s.id, name: s.name }))}
          view={show}
          query={keep.toString()}
          sort={sort}
          currency={tenant.currency}
        />
      )}

      {pages > 1 && (
        <nav
          aria-label="Pages"
          className="flex items-center justify-between gap-3 text-sm print:hidden"
        >
          <span className="text-muted-foreground tabular-nums">
            {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, shown.length)} of {shown.length}
          </span>
          <span className="flex gap-2">
            {page > 1 && (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(page - 1)}>Earlier</Link>
              </Button>
            )}
            {page < pages && (
              <Button asChild variant="outline" size="sm">
                <Link href={pageHref(page + 1)}>More</Link>
              </Button>
            )}
          </span>
        </nav>
      )}
    </>
  );
}
