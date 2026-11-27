import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
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
  invoiceHref,
  parseInvoiceQuery,
} from "@/lib/dashboard/invoices";
import { hasLines } from "@/lib/dashboard/lines";
import { loadInvoicesWaiting } from "@/lib/dashboard/setup-data";
import { dayIn } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { loadInvoiceCounts, loadInvoiceList } from "./data";
import { InvoiceTable } from "./invoice-table";

export const metadata: Metadata = { title: "Invoices" };

/**
 * Money → Invoices: the invoices in the books, read every few hours, each
 * paid, open or overdue by the workspace's own today, and the business line
 * each counts in, and why. The view, search, line ("not sorted yet"
 * included) and page are in the address. The whole team can look; owners
 * and admins sort invoices into lines here. Nothing here changes the books.
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
  const { tenant, role } = ctx;
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
  const lines = hasLines(revenue) ? revenue.lines : [];
  const canEdit = canManage(role) && entitlements.canWrite;
  const [counts, waiting, list] = await Promise.all([
    loadInvoiceCounts(supabase, tenant.id, today),
    loadInvoicesWaiting(supabase, tenant.id, revenue),
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

          {!revenue.books.invoices && (
            <p className="bg-muted rounded-md px-3 py-2 text-sm" role="note">
              Invoices aren&apos;t counted in your revenue yet. You can still sort them into lines
              now; they&apos;ll count once you switch on &ldquo;Add paid invoices from my
              books&rdquo;.{" "}
              <Link
                href={`${base}/settings/money/lines#books`}
                className="underline underline-offset-4"
              >
                Switch it on in Settings
              </Link>
            </p>
          )}
          {lines.length === 0 ? (
            <p className="bg-muted rounded-md px-3 py-2 text-sm" role="note">
              Set up your business lines first, then you can say which line each invoice belongs to.{" "}
              <Link
                href={`${base}/settings/money/lines#rules`}
                className="underline underline-offset-4"
              >
                Set up lines
              </Link>
            </p>
          ) : (
            waiting !== null &&
            waiting.invoices > 0 && (
              <p
                className="bg-ochre-soft text-ochre-text flex flex-wrap items-center gap-x-2 rounded-md px-3 py-2 text-sm"
                role="status"
              >
                <span>
                  {waiting.invoices.toLocaleString("en-US")}{" "}
                  {waiting.invoices === 1 ? "invoice isn't" : "invoices aren't"} in a business line
                  yet ({money(waiting.cents)} before tax).
                </span>
                {!query.waiting && (
                  <Link
                    href={invoiceHref(here, shown, { waiting: true })}
                    className="font-medium underline underline-offset-4"
                  >
                    Show them
                  </Link>
                )}
                <Link
                  href={`${base}/settings/money/lines#books`}
                  className="underline underline-offset-4"
                >
                  Choose by income account
                </Link>
              </p>
            )
          )}

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
            {lines.length > 0 && (
              <label className="flex flex-col gap-1 text-xs">
                <span className="text-muted-foreground">Business line</span>
                <select
                  name="line"
                  defaultValue={query.waiting ? "" : (line?.id ?? "")}
                  className="border-input bg-card h-9 rounded-sm border px-2 text-sm"
                >
                  <option value="">Every line</option>
                  {lines.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {lines.length > 0 && (
              <label className="flex items-center gap-2 self-center pt-4 text-sm">
                <input type="checkbox" name="waiting" value="1" defaultChecked={query.waiting} />
                Not sorted yet
              </label>
            )}
            <Button type="submit" variant="outline">
              Show
            </Button>
            {(query.q || line || query.waiting) && (
              <Button asChild variant="ghost">
                <Link href={invoiceHref(here, shown, { q: "", line: null, waiting: false })}>
                  Clear
                </Link>
              </Button>
            )}
          </form>

          <p className="text-muted-foreground text-sm" role="status">
            {list.total === 0
              ? "No invoices match."
              : `${list.total.toLocaleString("en-US")} ${list.total === 1 ? "invoice" : "invoices"}${
                  query.waiting ? " not sorted yet" : line ? ` counting in ${line.name}` : ""
                }.`}
          </p>

          {list.rows.length > 0 && (
            <InvoiceTable
              slug={tenant.slug}
              rows={list.rows}
              lines={lines}
              customers={revenue.books.customers}
              currency={tenant.currency}
              today={today}
              canEdit={canEdit && lines.length > 0}
            />
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
