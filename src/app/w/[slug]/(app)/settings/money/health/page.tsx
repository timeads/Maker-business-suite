import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeConfig, findConfig } from "@/lib/assistant/registry";
import { requireUser } from "@/lib/auth";
import { loadHealthSettings } from "@/lib/dashboard/data";
import { HEALTH_FIELDS } from "@/lib/dashboard/figure-fields";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { FigureSettingsForm } from "../../../dashboard/money-figure-forms";

export const metadata: Metadata = { title: "Cash health" };

/**
 * Settings → Money → Cash health: where runway, growth, margin and one line's share count as healthy, worth watching or needing attention, and the notes written from them. The whole team can look; owners and admins
 * change it.
 */
export default async function HealthSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/health`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const settings = await loadHealthSettings(supabase, tenant.id);
  const entry = findConfig("dashboard", "health")!;

  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard`, label: "Money" }}
        title="Cash health"
        description="Where your figures count as healthy, worth watching or needing attention. They start at the usual rules of thumb; change any that don't fit your business."
      />
      <Card>
        <CardHeader>
          <CardTitle>Thresholds</CardTitle>
          <CardDescription>
            These colour the cash health tiles on Money and write its notes. Pick the “Cash and
            health” layout to see them on{" "}
            <Link href={`${base}/dashboard`} className="underline underline-offset-4">
              Money
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <FigureSettingsForm
              slug={tenant.slug}
              setting="health"
              groups={HEALTH_FIELDS}
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
