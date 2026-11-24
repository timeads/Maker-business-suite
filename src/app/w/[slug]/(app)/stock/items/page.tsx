import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/ui/page-header";
import { shopPhotoAddress } from "@/lib/social/product-photos";
import { createClient } from "@/lib/supabase/server";
import {
  DEFAULT_SORT,
  VIEWS,
  VIEW_NOTES,
  isColumnKey,
  isViewKey,
  rankRows,
  searchRows,
  sortRows,
  toGridRow,
  viewRows,
} from "@/lib/stock/views";
import { canManage } from "@/lib/tenants";
import { loadOrderTracking, loadStock } from "../data";
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
  searchParams: Promise<{
    show?: string;
    q?: string;
    sort?: string;
    dir?: string;
    page?: string;
    saved?: string;
  }>;
}) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/items`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const query = await searchParams;
  const base = `/w/${tenant.slug}/stock`;

  const supabase = await createClient();
  const [{ rows, suppliers, today, savedViews }, tracking] = await Promise.all([
    loadStock(supabase, tenant),
    loadOrderTracking(supabase, tenant),
  ]);

  // A saved view fills in whatever the address doesn't say for itself. With
  // nothing in the address at all, the list opens on the view marked for that.
  const bare = !query.show && !query.sort && !query.saved && query.q === undefined;
  const saved =
    savedViews.find((view) => view.id === query.saved) ??
    (bare ? savedViews.find((view) => view.opens_first) : undefined);
  const wantedShow = query.show ?? saved?.view;
  const show = isViewKey(wantedShow) ? wantedShow : "all";
  const q = (query.q ?? saved?.q ?? "").trim().slice(0, 80);
  const wantedSort = query.sort ?? saved?.sort;
  const sort = isColumnKey(wantedSort)
    ? {
        key: wantedSort,
        dir:
          (query.sort ? query.dir : saved?.dir) === "desc" ? ("desc" as const) : ("asc" as const),
      }
    : DEFAULT_SORT;
  const savedColumns = saved && saved.columns.length > 0 ? saved.columns.filter(isColumnKey) : null;

  const views = viewRows(rows, today);
  const ranks = rankRows(views[show]);
  const shown = sortRows(searchRows(views[show], q), sort.key, sort.dir);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(query.page ?? "1", 10) || 1));
  const onPage = shown.slice((page - 1) * PER_PAGE, page * PER_PAGE);

  // The view and search, carried by the sort links, the page links and the download.
  const keep = new URLSearchParams({ show });
  if (q) keep.set("q", q);
  if (saved) keep.set("saved", saved.id);
  const pageHref = (n: number) => {
    const search = new URLSearchParams(keep);
    search.set("sort", sort.key);
    search.set("dir", sort.dir);
    if (n > 1) search.set("page", String(n));
    return `${base}/items?${search}`;
  };

  return (
    <>
      <PageHeader
        title="Stock"
        description="Every item your shop keeps a count of, soonest to reorder first. Tick the ones you want and draft an order for them."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />

      <ItemsGrid
        slug={tenant.slug}
        rows={onPage.map((row) =>
          toGridRow(row, today, {
            rank: ranks.get(row.item.id) ?? null,
            photo: shopPhotoAddress(row.photo, 96),
            tracking,
          }),
        )}
        total={shown.length}
        canEdit={canEdit}
        suppliers={suppliers.filter((s) => !s.archived_at).map((s) => ({ id: s.id, name: s.name }))}
        views={VIEWS.map(([key, label]) => ({ key, label, count: views[key].length }))}
        view={show}
        note={VIEW_NOTES[show] ?? null}
        q={q}
        savedViews={savedViews.map((view) => ({ id: view.id, name: view.name }))}
        savedId={saved?.id ?? null}
        savedColumns={savedColumns}
        query={keep.toString()}
        sort={sort}
        currency={tenant.currency}
        emptyText={
          rows.length === 0
            ? "Your shop's items appear here after the next sync."
            : show === "hidden" && !q
              ? "Nothing is hidden. To stop reordering something, press “Hide” on its row under All."
              : "Nothing matches."
        }
      />

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
