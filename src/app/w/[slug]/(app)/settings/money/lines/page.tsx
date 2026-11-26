import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  FIGURE_WORDS,
  MATCH_WORDS,
  defaultLineCount,
  hasLines,
  type RecentLine,
} from "@/lib/dashboard/lines";
import { localDate, startOfLocalDay } from "@/lib/dashboard/range";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { BusinessLinesForm, RevenueFigureForm } from "../../../dashboard/revenue-forms";

export const metadata: Metadata = { title: "Revenue and business lines" };

/** How far back the count of orders falling to the default line looks. */
const RECENT_DAYS = 90;
const PAGE = 1000;
const MAX_PAGES = 10;

type Row = RecentLine & { product_external_id: string | null };

/** The most common words, most used first. */
function commonest(values: Iterable<string>, limit: number): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

/**
 * Settings → Money → Revenue and business lines: which figure counts as
 * revenue, whether a class counts when it runs, and the business's own lines
 * with the rules that sort sales into them. The whole team can look; owners
 * and admins change it.
 */
export default async function RevenueLinesSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/lines`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const settings = await loadRevenueSettings(supabase, tenant.id);

  // The items of the last ninety days' orders, read as the member, paged.
  const today = localDate(new Date(), tenant.timezone);
  const since = startOfLocalDay(
    (() => {
      const d = new Date(Date.UTC(today.year, today.month - 1, today.day - RECENT_DAYS));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    })(),
    tenant.timezone,
  );
  const recent: Row[] = [];
  let complete = true;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await supabase
      .rpc("money_recent_order_lines", { p_tenant_id: tenant.id, p_from: since.toISOString() })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) {
      complete = false;
      break;
    }
    const batch = (data as Row[] | null) ?? [];
    recent.push(...batch);
    if (batch.length < PAGE) break;
    if (page === MAX_PAGES - 1) complete = false;
  }
  const count = hasLines(settings) ? defaultLineCount(settings, recent) : null;
  const defaultName =
    settings.lines.find((line) => line.id === settings.default_line)?.name ?? "the default line";
  const seenTags = new Map<string, string[]>();
  for (const row of recent) {
    if (!seenTags.has(row.order_id)) seenTags.set(row.order_id, row.order_tags ?? []);
  }
  const suggestions = {
    orderTags: commonest([...seenTags.values()].flat(), 20),
    productTypes: commonest(
      recent.map((row) => row.product_type ?? "").filter((type) => type.trim() !== ""),
      20,
    ),
  };

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard`, label: "Money" }}
        title="Revenue and business lines"
        description="What Money counts as revenue, and how your sales split into the parts of your business."
      />

      <Card>
        <CardHeader>
          <CardTitle>How revenue is counted</CardTitle>
          <CardDescription>
            Cancelled and test orders never count. Every figure on Money says which of these it
            shows.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <RevenueFigureForm slug={tenant.slug} settings={settings} />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              <li>{FIGURE_WORDS[settings.figure].choice}</li>
              <li>
                {settings.by_class_date
                  ? "Classes count in the month they run."
                  : "Classes count in the month they were bought."}
              </li>
              <li className="text-muted-foreground">An owner or admin can change these.</li>
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your business lines</CardTitle>
          <CardDescription>
            Sort your sales into the parts of your business by the tags on your shop&apos;s orders
            and products, product types, or the workshops Bookings sells through your shop. Money
            then shows each line on its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {count && (
            <p className="bg-muted rounded-md px-3 py-2 text-sm" role="status">
              {count.orders === 0
                ? `No orders in the last ${RECENT_DAYS} days to check these against yet.`
                : count.toDefault === 0
                  ? `Every one of your ${count.orders.toLocaleString("en-US")} orders in the last ${RECENT_DAYS} days matched a rule.`
                  : `${count.toDefault.toLocaleString("en-US")} of your ${count.orders.toLocaleString("en-US")} orders in the last ${RECENT_DAYS} days had something no rule matched, so it went to ${defaultName}${
                      count.wholly === count.toDefault
                        ? "."
                        : ` (${count.wholly.toLocaleString("en-US")} of them wholly).`
                    }`}
              {!complete && " That's counted from the most recent orders only."}
            </p>
          )}
          {canEdit ? (
            <BusinessLinesForm slug={tenant.slug} settings={settings} suggestions={suggestions} />
          ) : settings.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No lines set up yet. An owner or admin can add them here.
            </p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <p>
                {settings.lines.map((line) => line.name).join(", ")}. Anything no rule matches goes
                to {defaultName}.
              </p>
              <ol className="list-decimal pl-5">
                {settings.rules.map((rule) => (
                  <li key={rule.id}>
                    {MATCH_WORDS[rule.match].label}
                    {rule.words.length > 0 && ` ${rule.words.map((w) => `“${w}”`).join(" or ")}`}
                    {" → "}
                    {settings.lines.find((line) => line.id === rule.line)?.name}
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground">An owner or admin can change these.</p>
            </div>
          )}
          <p className="text-muted-foreground text-xs">
            Past orders are sorted again whenever the rules change. Tags and class dates are read
            from your shop with each sync; orders from before this was added fill in by themselves
            within a day.{" "}
            <Link href={`${base}/dashboard`} className="underline underline-offset-4">
              See them on Money
            </Link>
          </p>
        </CardContent>
      </Card>
    </>
  );
}
