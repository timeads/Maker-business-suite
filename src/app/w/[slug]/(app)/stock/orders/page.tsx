import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { formatMoney } from "@/lib/dashboard/format";
import { ORDER_STATUS } from "@/lib/stock/plan";
import {
  ORDER_VIEWS,
  SHIPPING_TONES,
  isOrderView,
  orderViewRows,
  searchOrders,
} from "@/lib/stock/po/list";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { loadOrderList } from "../data";
import { NewOrderForm } from "../forms";
import { stockAccess } from "../gate";

export const metadata: Metadata = { title: "Stock orders" };

const count = (value: string | undefined) => Math.max(0, Number.parseInt(value ?? "0", 10) || 0);
const PER_PAGE = 100;

const chip = "rounded-full px-2.5 py-1 text-xs whitespace-nowrap transition-colors duration-150";
const chipOn = "bg-teal font-semibold text-white";
const chipOff = "bg-sunken text-text-2 hover:bg-hover";

export default async function StockOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    new?: string;
    nosupplier?: string;
    enough?: string;
    off?: string;
    show?: string;
    q?: string;
    supplier?: string;
    page?: string;
    gone?: string;
  }>;
}) {
  const { slug } = await params;
  const flags = await searchParams;
  const access = await stockAccess(slug, `/w/${slug}/stock/orders`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [orders, { data: supplierRows }] = await Promise.all([
    loadOrderList(supabase, tenant),
    supabase
      .from("suppliers")
      .select("id, name, archived_at")
      .eq("tenant_id", tenant.id)
      .order("name"),
  ]);
  const suppliers = (supplierRows ?? []) as {
    id: string;
    name: string;
    archived_at: string | null;
  }[];
  const base = `/w/${tenant.slug}/stock/orders`;
  // Orders just drafted from the items ticked under Everything.
  const fresh = new Set(
    (flags.new ?? "")
      .split("-")
      .map((n) => Number.parseInt(n, 10))
      .filter((n) => n > 0),
  );
  const drafted = orders.filter((o) => fresh.has(o.number) && o.status === "draft");
  const leftOut = [
    count(flags.nosupplier) > 0 &&
      `${count(flags.nosupplier)} had no supplier (see Everything → No supplier)`,
    count(flags.enough) > 0 && `${count(flags.enough)} had enough in stock for now`,
    count(flags.off) > 0 && `${count(flags.off)} are set not to be reordered`,
  ].filter(Boolean);

  const views = orderViewRows(orders);
  // Opens on what is in progress, as TuftStock does; with nothing on order, on everything.
  const show = isOrderView(flags.show)
    ? flags.show
    : fresh.size > 0
      ? "draft"
      : views.progress.length > 0
        ? "progress"
        : "all";
  const q = (flags.q ?? "").trim().slice(0, 80);
  const supplierId = suppliers.some((s) => s.id === flags.supplier)
    ? (flags.supplier as string)
    : "";
  const shown = searchOrders(views[show], q, supplierId || null);
  const pages = Math.max(1, Math.ceil(shown.length / PER_PAGE));
  const page = Math.min(pages, Math.max(1, Number.parseInt(flags.page ?? "1", 10) || 1));
  const onPage = shown.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const href = (changes: Record<string, string>) => {
    const search = new URLSearchParams({ show });
    if (q) search.set("q", q);
    if (supplierId) search.set("supplier", supplierId);
    for (const [key, value] of Object.entries(changes)) {
      if (value) search.set(key, value);
      else search.delete(key);
    }
    return `${base}?${search}`;
  };
  const exportHref = `${base}/export?${new URLSearchParams({
    show,
    ...(q ? { q } : {}),
    ...(supplierId ? { supplier: supplierId } : {}),
  })}`;
  const day = (value: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric" }).format(
      new Date(`${value.slice(0, 10)}T12:00:00Z`),
    );
  const emptyWords: Record<string, string> = {
    progress:
      "Nothing on order. Suggested orders are under “To order”, or tick items under “Everything” to draft your own.",
    draft: "No drafts waiting.",
    overdue: "Nothing is late.",
    all: "No orders yet.",
    archived: "Nothing has been put away. Archive a finished order from its own page.",
  };

  return (
    <>
      <PageHeader title="Orders" description="What you've ordered, and what has arrived." />
      {flags.gone && <FormMessage kind="success">That draft is deleted.</FormMessage>}
      {drafted.length > 0 && (
        <FormMessage kind="success">
          {drafted.length} draft orders are ready, one for each supplier:{" "}
          {drafted
            .map((o) => `${o.reference} ${o.supplierName}`.trim())
            .reverse()
            .join(", ")}
          . Open each to check the quantities, then send it.
          {leftOut.length > 0 && ` Left off: ${leftOut.join("; ")}.`}
        </FormMessage>
      )}

      <div className="flex flex-col gap-3 print:hidden">
        <nav aria-label="Views" className="flex flex-wrap items-center gap-1.5">
          {ORDER_VIEWS.map(([key, label]) => (
            <Link
              key={key}
              href={`${base}?${new URLSearchParams({
                show: key,
                ...(q ? { q } : {}),
                ...(supplierId ? { supplier: supplierId } : {}),
              })}`}
              aria-current={show === key ? "page" : undefined}
              className={cn(chip, show === key ? chipOn : chipOff)}
            >
              {label} <span className="tabular-nums opacity-80">{views[key].length}</span>
            </Link>
          ))}
        </nav>
        <form role="search" className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="show" value={show} />
          <Input
            name="q"
            type="search"
            defaultValue={q}
            placeholder="Search reference, supplier…"
            aria-label="Search orders"
            className="h-[30px] w-full max-w-xs text-sm"
          />
          <Select
            name="supplier"
            defaultValue={supplierId}
            aria-label="Only this supplier's orders"
            className="h-[30px] w-52 py-0 text-sm"
          >
            <option value="">Every supplier</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="outline" size="sm">
            Show
          </Button>
          {(q || supplierId) && (
            <Button asChild variant="ghost" size="sm">
              <Link href={`${base}?show=${show}`}>Clear</Link>
            </Button>
          )}
          <Button asChild variant="outline" size="sm">
            <a href={exportHref}>
              <Download /> Export CSV
            </a>
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {shown.length} order{shown.length === 1 ? "" : "s"}
          </span>
        </form>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{ORDER_VIEWS.find(([key]) => key === show)?.[1]}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {onPage.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {q || supplierId ? "Nothing matches." : emptyWords[show]}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-muted-foreground text-xs">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">Reference</th>
                    <th className="py-2 pr-3 font-semibold">Supplier</th>
                    <th className="py-2 pr-3 text-right font-semibold">Items · units</th>
                    <th className="py-2 pr-3 font-semibold">Expected</th>
                    <th className="py-2 pr-3 font-semibold">Sent</th>
                    <th className="py-2 pr-3 font-semibold">Status</th>
                    <th className="py-2 pr-3 font-semibold">Shipping</th>
                    <th className="py-2 text-right font-semibold">Value</th>
                  </tr>
                </thead>
                <tbody className="divide-border divide-y">
                  {onPage.map((order) => {
                    const status = ORDER_STATUS[order.status] ?? ORDER_STATUS.draft;
                    return (
                      <tr key={order.id} className="hover:bg-hover align-middle">
                        <td className="py-2.5 pr-3">
                          <Link
                            href={`${base}/${order.number}`}
                            className="font-mono text-xs font-semibold hover:underline"
                          >
                            {order.reference}
                          </Link>
                        </td>
                        <td className="py-2.5 pr-3 font-semibold">{order.supplierName}</td>
                        <td className="py-2.5 pr-3 text-right tabular-nums">
                          {order.items} ·{" "}
                          {order.status === "partial"
                            ? `${order.received} of ${order.units}`
                            : order.units.toLocaleString("en-US")}
                        </td>
                        <td
                          className={cn(
                            "py-2.5 pr-3 whitespace-nowrap",
                            order.late && "text-brick font-semibold",
                          )}
                        >
                          {order.expectedOn ? day(order.expectedOn) : "–"}
                        </td>
                        <td className="text-muted-foreground py-2.5 pr-3 whitespace-nowrap">
                          {order.sentOn ? day(order.sentOn) : "–"}
                        </td>
                        <td className="py-2.5 pr-3">
                          <span className="flex flex-wrap items-center gap-1">
                            <Badge tone={status.tone}>{status.label}</Badge>
                            {order.late && <Badge tone="bad">Late</Badge>}
                            {fresh.has(order.number) && order.status === "draft" && (
                              <Badge tone="waiting">Just drafted</Badge>
                            )}
                            {order.archived && <Badge>Archived</Badge>}
                          </span>
                        </td>
                        <td className="py-2.5 pr-3">
                          {order.shipping.state === "none" ? (
                            <span className="text-muted-foreground">–</span>
                          ) : (
                            <span className="flex flex-wrap items-center gap-1.5">
                              <Badge tone={SHIPPING_TONES[order.shipping.state]}>
                                {order.shipping.label}
                              </Badge>
                              {order.shipping.nextEta && (
                                <span className="text-muted-foreground text-xs whitespace-nowrap">
                                  due {day(order.shipping.nextEta)}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 text-right tabular-nums">
                          {formatMoney(Number(order.value), tenant.currency)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground tabular-nums">
                {(page - 1) * PER_PAGE + 1}–{Math.min(page * PER_PAGE, shown.length)} of{" "}
                {shown.length}
              </span>
              <span className="flex gap-2">
                {page > 1 && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={href({ page: page > 2 ? String(page - 1) : "" })}>Newer</Link>
                  </Button>
                )}
                {page < pages && (
                  <Button asChild variant="outline" size="sm">
                    <Link href={href({ page: String(page + 1) })}>Older</Link>
                  </Button>
                )}
              </span>
            </nav>
          )}
          {canManage(role) &&
            entitlements.canWrite &&
            suppliers.some((s) => !s.archived_at) &&
            show !== "archived" && (
              <div id="new-order" className="border-border scroll-mt-6 border-t pt-4">
                <NewOrderForm
                  slug={tenant.slug}
                  suppliers={suppliers
                    .filter((s) => !s.archived_at)
                    .map((s) => ({ id: s.id, name: s.name }))}
                />
              </div>
            )}
        </CardContent>
      </Card>
    </>
  );
}
