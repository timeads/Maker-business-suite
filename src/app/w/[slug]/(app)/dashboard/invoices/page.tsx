import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import { invoicesExplained } from "@/lib/dashboard/explain";
import { formatMoney } from "@/lib/dashboard/format";
import {
  INVOICE_PAGE,
  INVOICE_VIEWS,
  INVOICE_VIEW_NAMES,
  STATUS_WORDS,
  daysLate,
  invoiceHref,
  parseInvoiceQuery,
  type InvoiceStatus,
} from "@/lib/dashboard/invoices";
import { dayIn } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { loadInvoiceCounts, loadInvoiceList } from "./data";

export const metadata: Metadata = { title: "Invoices" };

const TONE: Record<InvoiceStatus, BadgeTone> = { paid: "good", open: "open", overdue: "bad" };

const shortDay = (iso: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(
    new Date(`${iso}T00:00:00Z`),
  );

/**
 * Money → Invoices: the invoices in the books, read every few hours, each
 * paid, open or overdue by the workspace's own today. The view, search,
 * line and page are in the address. The whole team can look; nothing here
 * changes the books.
 */
export default async function InvoicesPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/dashboard/invoices`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;
  const here = `${base}/dashboard/invoices`;
  const query = parseInvoiceQuery(await searchParams);
  const today = dayIn(new Date(), tenant.timezone);

  const supabase = await createClient();
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const line = revenue.lines.find((l) => l.id === query.line) ?? null;
  const shown = { ...query, line: line?.id ?? null };
  const [counts, list] = await Promise.all([
    loadInvoiceCounts(supabase, tenant.id, today),
    loadInvoiceList(supabase, tenant.id, revenue, shown, today, {
      limit: INVOICE_PAGE,
      offset: (query.page - 1) * INVOICE_PAGE,
    }),
  ]);
  const money = (cents: number) => formatMoney(cents / 100, tenant.currency);
  const all = counts.open.invoices + counts.overdue.invoices + counts.paid.invoices;
  const pages = Math.max(1, Math.ceil(list.total / INVOICE_PAGE));
  const exportHref = invoiceHref(`${here}/export`, shown, { page: 1 });

  return (
    <>
      <PageHeader
        title="Invoices"
        description="The invoices in your books: who they're for, when they're due and what's still owed."
      >
        {all > 0 && (
          <Button asChild variant="outline">
            <a href={exportHref}>Download as a spreadsheet</a>
          </Button>
        )}
      </PageHeader>

      {all === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No invoices from your books yet</CardTitle>
            <CardDescription>
              Once QuickBooks is connected, its invoices show up here within a few hours, from three
              Januaries back. Nothing is ever changed in your books.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href={`${base}/connections`}>Go to Connections</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="bg-card rounded-md border p-3">
              <dt className="text-muted-foreground text-xs">Still owed, not yet due</dt>
              <dd className="text-lg font-semibold tabular-nums">{money(counts.open.owed)}</dd>
            </div>
            <div className="bg-card rounded-md border p-3">
              <dt className="text-muted-foreground text-xs">Overdue</dt>
              <dd className="text-lg font-semibold tabular-nums">{money(counts.overdue.owed)}</dd>
            </div>
            <div className="bg-card rounded-md border p-3">
              <dt className="text-muted-foreground text-xs">Paid invoices</dt>
              <dd className="text-lg font-semibold tabular-nums">
                {counts.paid.invoices.toLocaleString("en-US")}
              </dd>
            </div>
          </dl>

          <nav
            aria-label="Which invoices"
            className="bg-muted flex w-fit flex-wrap gap-1 rounded-lg p-1"
          >
            {INVOICE_VIEWS.map((view) => {
              const count = view === "all" ? all : counts[view].invoices;
              return (
                <Link
                  key={view}
                  href={invoiceHref(here, shown, { view })}
                  aria-current={view === query.view ? "true" : undefined}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    view === query.view
                      ? "bg-card font-medium shadow-xs"
                      : "text-muted-foreground hover:bg-card/60",
                  )}
                >
                  {INVOICE_VIEW_NAMES[view]} ({count.toLocaleString("en-US")})
                </Link>
              );
            })}
          </nav>

          <form action={here} className="flex flex-wrap items-end gap-2" role="search">
            {query.view !== "all" && <input type="hidden" name="view" value={query.view} />}
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-muted-foreground">Search</span>
              <input
                name="q"
                defaultValue={query.q}
                placeholder="Number, customer or memo"
                className="border-input bg-card h-9 w-full rounded-sm border px-3 text-sm sm:w-72"
              />
            </label>
            {revenue.lines.length > 0 && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Business line</span>
                <select
                  name="line"
                  defaultValue={line?.id ?? ""}
                  className="border-input bg-card h-9 rounded-sm border px-2 text-sm"
                >
                  <option value="">Every line</option>
                  {revenue.lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Button type="submit" variant="outline">
              Show
            </Button>
            {(query.q || line) && (
              <Button asChild variant="ghost">
                <Link href={invoiceHref(here, shown, { q: "", line: null })}>Clear</Link>
              </Button>
            )}
          </form>

          <p className="text-muted-foreground text-sm" role="status">
            {list.total === 0
              ? "No invoices match."
              : `${list.total.toLocaleString("en-US")} ${list.total === 1 ? "invoice" : "invoices"}${
                  line ? ` with lines in ${line.name}` : ""
                }.`}
          </p>

          {list.rows.length > 0 && (
            <div className="bg-card overflow-x-auto rounded-md border">
              <table className="w-full min-w-[40rem] text-sm">
                <caption className="sr-only">Invoices from your books</caption>
                <thead className="text-muted-foreground text-xs">
                  <tr className="border-border border-b text-left">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Number
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Customer
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Date
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Due
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Amount
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      Still owed
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.rows.map((row) => (
                    <tr key={row.id} className="border-border border-b last:border-0">
                      <td className="px-3 py-2 tabular-nums">{row.doc_number ?? "–"}</td>
                      <td className="font-read px-3 py-2">{row.customer ?? "–"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{shortDay(row.txn_date)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {row.due_date ? shortDay(row.due_date) : "–"}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {money(row.total_cents)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {row.balance_cents > 0 ? money(row.balance_cents) : "–"}
                      </td>
                      <td className="px-3 py-2">
                        <Badge tone={TONE[row.status]}>
                          {row.status === "overdue"
                            ? `${STATUS_WORDS.overdue}, ${daysLate(row.due_date, today)} days`
                            : STATUS_WORDS[row.status]}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {pages > 1 && (
            <nav aria-label="Pages" className="flex items-center gap-2 text-sm">
              {query.page > 1 && (
                <Button asChild variant="outline" size="sm">
                  <Link href={invoiceHref(here, shown, { page: query.page - 1 })}>Newer</Link>
                </Button>
              )}
              <span className="text-muted-foreground">
                Page {query.page} of {pages}
              </span>
              {query.page < pages && (
                <Button asChild variant="outline" size="sm">
                  <Link href={invoiceHref(here, shown, { page: query.page + 1 })}>Older</Link>
                </Button>
              )}
            </nav>
          )}

          <HowWorkedOut
            lines={invoicesExplained(revenue)}
            change={{
              href: `${base}/settings/money/lines#books`,
              label: "Choose how invoices count",
            }}
          />
        </>
      )}
    </>
  );
}
