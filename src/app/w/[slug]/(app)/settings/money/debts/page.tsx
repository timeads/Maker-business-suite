import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeConfig, findConfig } from "@/lib/assistant/registry";
import { requireUser } from "@/lib/auth";
import { loadDebtSettings } from "@/lib/dashboard/debt/data";
import { DEBT_FIELDS } from "@/lib/dashboard/figure-fields";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { FigureSettingsForm } from "../../../dashboard/money-figure-forms";

export const metadata: Metadata = { title: "Debt payoff and emergency fund" };

/**
 * Settings → Money → Debt payoff and emergency fund. Owners and admins only:
 * for anyone else this page doesn't exist, and the database won't hand them
 * the setting either.
 */
export default async function DebtSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/debts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) notFound();
  const { tenant } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [settings, sheet] = await Promise.all([
    loadDebtSettings(supabase, tenant.id),
    supabase
      .from("financial_snapshots")
      .select("data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "balance_sheet")
      .order("period_start", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const banks = Array.isArray(sheet.data?.data?.bank_accounts)
    ? (sheet.data.data.bank_accounts as { name: string }[]).map((a) => a.name)
    : [];
  const entry = findConfig("dashboard", "debt")!;

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/debts`, label: "Payoff plan" }}
        title="Debt payoff and emergency fund"
        description="How your payoff plan sends extra money, and how your emergency fund is built up alongside it. Only owners and admins see any of this."
      />
      <Card>
        <CardHeader>
          <CardTitle>The plan</CardTitle>
          <CardDescription>
            The debts themselves are typed in on{" "}
            <Link
              href={`${base}/dashboard/debts/accounts`}
              className="underline underline-offset-4"
            >
              Debts
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {entitlements.canWrite ? (
            <FigureSettingsForm
              slug={tenant.slug}
              setting="debt"
              groups={DEBT_FIELDS}
              body={settings as unknown as Record<string, unknown>}
              currency={tenant.currency}
            />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {describeConfig(entry, settings).map((line) => (
                <li key={line}>{line}.</li>
              ))}
            </ul>
          )}
          {banks.length > 0 && (
            <p className="text-muted-foreground text-xs">
              Bank accounts on your latest balance sheet: {banks.join(", ")}.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
