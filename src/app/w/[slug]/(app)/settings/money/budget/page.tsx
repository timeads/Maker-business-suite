import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeConfig, findConfig } from "@/lib/assistant/registry";
import { requireUser } from "@/lib/auth";
import { loadBudgetSettings } from "@/lib/dashboard/data";
import { BUDGET_FIELDS } from "@/lib/dashboard/figure-fields";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { FigureSettingsForm } from "../../../dashboard/money-figure-forms";

export const metadata: Metadata = { title: "Budget and break-even" };

/**
 * Settings → Money → Budget and break-even: the cost of goods share, which accounts rise and fall with sales, which are left off, and when spending is flagged. The whole team can look; owners and admins
 * change it.
 */
export default async function BudgetSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/budget`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const settings = await loadBudgetSettings(supabase, tenant.id);
  const entry = findConfig("dashboard", "budget")!;

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/budget`, label: "Budget" }}
        title="Budget and break-even"
        description="How the budget works out break-even and which spending it flags. The budgets themselves are typed in on the Budget page."
      />
      <Card>
        <CardHeader>
          <CardTitle>How the budget reads your books</CardTitle>
          <CardDescription>
            Budgets for each account and line are typed in on{" "}
            <Link href={`${base}/dashboard/budget`} className="underline underline-offset-4">
              Money → Budget
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <FigureSettingsForm
              slug={tenant.slug}
              setting="budget"
              groups={BUDGET_FIELDS}
              body={settings as unknown as Record<string, unknown>}
              currency={tenant.currency}
            />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {describeConfig(entry, settings).map((line) => (
                <li key={line}>{line}.</li>
              ))}
              <li className="text-muted-foreground">An owner or admin can change these.</li>
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
