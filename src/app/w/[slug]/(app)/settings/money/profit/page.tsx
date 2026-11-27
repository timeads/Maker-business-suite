import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HowWorkedOut } from "@/components/setup/how-worked-out";
import { profitExplained } from "@/lib/dashboard/explain";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadProfitSettings, loadRevenueSettings } from "@/lib/dashboard/data";
import { formatMoney } from "@/lib/dashboard/format";
import { COGS_WORDS, COST_WORDS, monthlyCostCents } from "@/lib/dashboard/profit";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { ProfitSettingsForm } from "../../../dashboard/money-settings-forms";
import { MonthEntriesForm, type MonthEntryRow } from "../../../dashboard/month-entries-form";
import { monthName } from "@/lib/dashboard/inbox";
import { addMonths } from "@/lib/dashboard/budget";
import { currentMonth } from "@/lib/dashboard/range";

export const metadata: Metadata = { title: "Profit by line" };

/**
 * Settings → Money → Profit by line: whether cost of goods comes from the
 * shop, how shared costs are shared out, and the monthly costs the books
 * don't hold. The whole team can look; owners and admins change it.
 */
export default async function ProfitSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const { slug } = await params;
  const asked = (await searchParams).month;
  const user = await requireUser(`/w/${slug}/settings/money/profit`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [revenue, settings] = await Promise.all([
    loadRevenueSettings(supabase, tenant.id),
    loadProfitSettings(supabase, tenant.id),
  ]);
  // Month by month: one month's entries at a time, this month unless another is asked for.
  const thisMonth = currentMonth(new Date(), tenant.timezone);
  const month =
    typeof asked === "string" &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(asked) &&
    asked <= addMonths(thisMonth, 2)
      ? asked
      : thisMonth;
  const { data: entryData } = await supabase
    .from("money_line_entries")
    .select("kind, month, subject, amount_cents, note")
    .eq("tenant_id", tenant.id)
    .order("month", { ascending: false })
    .limit(1000);
  const entryRows = (entryData ?? []) as {
    kind: string;
    month: string;
    subject: string;
    amount_cents: number;
    note: string | null;
  }[];
  const entryFor = (kind: string, subject: string) =>
    entryRows.find((e) => e.kind === kind && e.subject === subject && e.month.startsWith(month));
  const monthRows: MonthEntryRow[] = [
    ...settings.monthly_costs.map((c) => ({
      kind: "cost" as const,
      subject: c.id,
      name: c.name,
      usual: monthlyCostCents(c),
      cents: entryFor("cost", c.id) ? Number(entryFor("cost", c.id)!.amount_cents) : null,
      note: entryFor("cost", c.id)?.note ?? "",
    })),
    ...revenue.lines.map((l) => ({
      kind: "revenue" as const,
      subject: l.id,
      name: l.name,
      usual: null,
      cents: entryFor("revenue", l.id) ? Number(entryFor("revenue", l.id)!.amount_cents) : null,
      note: entryFor("revenue", l.id)?.note ?? "",
    })),
  ];
  const changed = [...new Set(entryRows.map((e) => e.month.slice(0, 7)))];
  const lineName = (id: string) =>
    revenue.lines.find((line) => line.id === id)?.name ?? "a removed line";
  const shares = (split: Record<string, number>) =>
    Object.entries(split)
      .map(([line, pct]) => `${pct}% ${lineName(line)}`)
      .join(", ");

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard`, label: "Money" }}
        title="Profit by line"
        description="What each line costs to run, so Money can show what each one really makes: its revenue, less its cost of goods, its own expenses, its share of what's shared and its share of your monthly costs."
      />
      <Card id="split" className="scroll-mt-4">
        <CardHeader>
          <CardTitle>How each line&apos;s costs are counted</CardTitle>
          <CardDescription>
            Expenses come from your books, sorted in{" "}
            <Link href={`${base}/dashboard/expenses`} className="underline underline-offset-4">
              Expenses to sort
            </Link>
            . These settings add what the books can&apos;t say: how shared costs split, and costs
            that never go through them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {revenue.lines.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Set up your business lines first.{" "}
              <Link href={`${base}/settings/money/lines`} className="underline underline-offset-4">
                Revenue and business lines
              </Link>
            </p>
          ) : canEdit ? (
            <ProfitSettingsForm
              slug={tenant.slug}
              settings={settings}
              lines={revenue.lines}
              currency={tenant.currency}
            />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              <li>{COGS_WORDS[settings.cost_of_goods]}.</li>
              <li>
                {Object.keys(settings.shared_split).length
                  ? `Shared costs: ${shares(settings.shared_split)}.`
                  : "Shared costs aren't split between lines yet."}
              </li>
              {settings.monthly_costs.map((c) => (
                <li key={c.id}>
                  {c.name}: {formatMoney(monthlyCostCents(c) / 100, tenant.currency)} a month (
                  {COST_WORDS[c.how].toLowerCase()}), {shares(c.split)}.
                </li>
              ))}
              <li className="text-muted-foreground">An owner or admin can change these.</li>
            </ul>
          )}
          {revenue.lines.length > 0 && (
            <div className="mt-4">
              <HowWorkedOut lines={profitExplained(settings, lineName)} />
            </div>
          )}
        </CardContent>
      </Card>
      {revenue.lines.length > 0 && (
        <Card id="months" className="scroll-mt-4">
          <CardHeader>
            <CardTitle>Month by month</CardTitle>
            <CardDescription>
              When a monthly cost came to something else one month (more hours of help, a smaller
              owner&apos;s pay), or a line had sales that reached neither your shop nor your books,
              put that month&apos;s figure here. Every other month keeps the usual amounts.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <nav aria-label="Months" className="flex flex-wrap items-center gap-2 text-sm">
              <Link
                href={`?month=${addMonths(month, -1)}#months`}
                className="underline underline-offset-4"
              >
                ← {monthName(addMonths(month, -1))}
              </Link>
              <span className="font-semibold">{monthName(month)}</span>
              {month < addMonths(thisMonth, 2) && (
                <Link
                  href={`?month=${addMonths(month, 1)}#months`}
                  className="underline underline-offset-4"
                >
                  {monthName(addMonths(month, 1))} →
                </Link>
              )}
            </nav>
            {canEdit ? (
              <MonthEntriesForm
                key={month}
                slug={tenant.slug}
                month={month}
                rows={monthRows}
                currency={tenant.currency}
              />
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {monthRows.filter((r) => r.cents !== null).length === 0 ? (
                  <li className="text-muted-foreground">Nothing typed in for this month.</li>
                ) : (
                  monthRows
                    .filter((r) => r.cents !== null)
                    .map((r) => (
                      <li key={`${r.kind}:${r.subject}`}>
                        {r.kind === "cost" ? r.name : `${r.name}, revenue from elsewhere`}:{" "}
                        {formatMoney((r.cents ?? 0) / 100, tenant.currency)}
                      </li>
                    ))
                )}
              </ul>
            )}
            {changed.length > 0 && (
              <p className="text-muted-foreground text-xs">
                Months with figures typed in:{" "}
                {changed.slice(0, 24).map((m, i) => (
                  <span key={m}>
                    {i > 0 && ", "}
                    <Link href={`?month=${m}#months`} className="underline underline-offset-4">
                      {monthName(m)}
                    </Link>
                  </span>
                ))}
                .
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
