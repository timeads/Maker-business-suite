import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeConfig, findConfig } from "@/lib/assistant/registry";
import { requireUser } from "@/lib/auth";
import { loadCutterSettings } from "@/lib/dashboard/data";
import { CUTTER_FIELDS } from "@/lib/dashboard/figure-fields";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { FigureSettingsForm } from "../../../dashboard/money-figure-forms";

export const metadata: Metadata = { title: "Cost cutter" };

/**
 * Settings → Money → Cost cutter: how recurring charges are found in the books' expenses, what's left out and when a charge is flagged. The whole team can look; owners and admins
 * change it.
 */
export default async function CostCutterSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/cost-cutter`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const settings = await loadCutterSettings(supabase, tenant.id);
  const entry = findConfig("dashboard", "cost_cutter")!;

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/cost-cutter`, label: "Cost cutter" }}
        title="Cost cutter"
        description="How Money finds the charges that come round every month, so you can decide what to keep."
      />
      <Card>
        <CardHeader>
          <CardTitle>Finding recurring charges</CardTitle>
          <CardDescription>
            The list itself, and what you decide about each charge, is on{" "}
            <Link href={`${base}/dashboard/cost-cutter`} className="underline underline-offset-4">
              Money → Cost cutter
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <FigureSettingsForm
              slug={tenant.slug}
              setting="cutter"
              groups={CUTTER_FIELDS}
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
