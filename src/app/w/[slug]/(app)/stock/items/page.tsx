import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { HEALTH_LABELS, isPlanned, relativeDay } from "@/lib/stock/plan";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../data";
import { AssignBar } from "../forms";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";

export const metadata: Metadata = { title: "Everything in stock" };

const TONES: Record<keyof typeof HEALTH_LABELS, BadgeTone> = {
  out: "bad",
  under: "waiting",
  healthy: "good",
  over: "open",
  nosales: "closed",
};
const FILTERS = [
  ["all", "All"],
  ["out", "Out of stock"],
  ["under", "Running low"],
  ["healthy", "Healthy"],
  ["over", "Too much"],
  ["nosales", "Not selling"],
  ["nosupplier", "No supplier"],
  ["hidden", "Not planned"],
] as const;

export default async function StockItemsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ show?: string; q?: string }>;
}) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/items`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const query = await searchParams;
  const show = FILTERS.some(([key]) => key === query.show) ? query.show! : "all";
  const q = (query.q ?? "").trim().toLowerCase().slice(0, 80);
  const base = `/w/${tenant.slug}/stock`;

  const { rows, suppliers, today } = await loadStock(await createClient(), tenant);
  const planned = rows.filter(isPlanned);
  const pool = show === "hidden" ? rows.filter((row) => !isPlanned(row)) : planned;
  const counts = Object.fromEntries(
    FILTERS.map(([key]) => [
      key,
      key === "all"
        ? planned.length
        : key === "hidden"
          ? rows.length - planned.length
          : key === "nosupplier"
            ? planned.filter((row) => !row.supplier).length
            : planned.filter((row) => row.health.health === key).length,
    ]),
  );
  const shown = pool
    .filter(
      (row) =>
        show === "all" ||
        show === "hidden" ||
        (show === "nosupplier" ? !row.supplier : row.health.health === show),
    )
    .filter(
      (row) =>
        !q ||
        row.name.toLowerCase().includes(q) ||
        (row.item.sku ?? "").toLowerCase().includes(q) ||
        (row.supplier?.name ?? "").toLowerCase().includes(q),
    );
  const LIMIT = 300;

  return (
    <>
      <PageHeader
        title="Stock"
        description="Every item your shop keeps a count of, and how each one is doing."
      />
      <StockTabs slug={tenant.slug} manager={canManage(role)} />

      <div className="flex flex-col gap-3 print:hidden">
        <nav aria-label="Filter" className="flex flex-wrap gap-1">
          {FILTERS.map(([key, label]) => (
            <Link
              key={key}
              href={`${base}/items${key === "all" ? "" : `?show=${key}`}`}
              aria-current={show === key ? "page" : undefined}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150",
                show === key ? "bg-teal font-semibold text-white" : "text-text-2 hover:bg-hover",
              )}
            >
              {label} <span className="tabular-nums opacity-80">{counts[key]}</span>
            </Link>
          ))}
        </nav>
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
        {canEdit && shown.length > 0 && (
          <AssignBar
            slug={tenant.slug}
            suppliers={suppliers
              .filter((s) => !s.archived_at)
              .map((s) => ({ id: s.id, name: s.name }))}
          />
        )}
      </div>

      <Card>
        <CardContent className="pt-5">
          {shown.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {rows.length === 0
                ? "Your shop's items appear here after the next sync."
                : "Nothing matches."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    {canEdit && <th className="w-8 py-2" aria-label="Pick" />}
                    <th className="py-2 pr-3 font-semibold">Item</th>
                    <th className="py-2 pr-3 text-right font-semibold">Have</th>
                    <th className="py-2 pr-3 text-right font-semibold">Coming</th>
                    <th className="py-2 pr-3 text-right font-semibold">Sells a month</th>
                    <th className="py-2 pr-3 font-semibold">Runs out</th>
                    <th className="py-2 pr-3 text-right font-semibold">Suggest</th>
                    <th className="py-2 font-semibold">How it&apos;s doing</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {shown.slice(0, LIMIT).map((row) => (
                    <tr key={row.item.id} className="align-top">
                      {canEdit && (
                        <td className="py-2.5">
                          <input
                            type="checkbox"
                            name="item"
                            value={row.item.id}
                            form="assign"
                            aria-label={`Pick ${row.name}`}
                          />
                        </td>
                      )}
                      <td className="py-2.5 pr-3">
                        <Link
                          href={`${base}/items/${row.item.id}`}
                          className="font-read font-semibold hover:underline"
                        >
                          {row.name}
                        </Link>
                        <span className="text-muted-foreground block text-xs">
                          {[row.item.sku, row.supplier?.name ?? "No supplier"]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </td>
                      <td
                        className={cn(
                          "py-2.5 pr-3 text-right tabular-nums",
                          row.item.on_hand <= 0 && "text-brick font-semibold",
                        )}
                      >
                        {row.item.on_hand}
                      </td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">{row.onOrder || "–"}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {row.plan.isDeadStock ? "–" : row.plan.velocityPerMonth.toFixed(1)}
                      </td>
                      <td className="py-2.5 pr-3">{relativeDay(row.plan.stockOutDate, today)}</td>
                      <td className="py-2.5 pr-3 text-right tabular-nums">
                        {row.plan.suggestedQty || "–"}
                      </td>
                      <td className="py-2.5">
                        <Badge tone={TONES[row.health.health]}>
                          {HEALTH_LABELS[row.health.health]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {shown.length > LIMIT && (
                <p className="text-muted-foreground mt-3 text-xs">
                  Showing the first {LIMIT} of {shown.length}. Search or filter to narrow it down.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
