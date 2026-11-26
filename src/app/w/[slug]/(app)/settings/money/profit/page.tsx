import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
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

export const metadata: Metadata = { title: "Profit by line" };

/**
 * Settings → Money → Profit by line: whether cost of goods comes from the
 * shop, how shared costs are shared out, and the monthly costs the books
 * don't hold. The whole team can look; owners and admins change it.
 */
export default async function ProfitSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
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
      <Card>
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
        </CardContent>
      </Card>
    </>
  );
}
