import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadRevenueSettings } from "@/lib/dashboard/data";
import {
  PROJECTION_KEY,
  PROJECTION_MODULE,
  parseProjectionSettings,
} from "@/lib/dashboard/projection";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { ProjectionForm } from "../../../dashboard/projection-form";

export const metadata: Metadata = { title: "Projection" };

/** Settings → Money → Projection: the yearly rates the 3-year projection grows by. */
export default async function ProjectionSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/money/projection`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const entitlements = await getEntitlements(tenant.id);
  if (!entitlements.can("module.dashboard")) notFound();
  const canEdit = canManage(role) && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;
  const supabase = await createClient();
  const [revenue, config] = await Promise.all([
    loadRevenueSettings(supabase, tenant.id),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", PROJECTION_MODULE)
      .eq("key", PROJECTION_KEY)
      .maybeSingle(),
  ]);
  const settings = parseProjectionSettings((config.data as { body?: unknown } | null)?.body);
  return (
    <>
      <SectionHeading
        back={{ href: `${base}/dashboard/projection`, label: "Projection" }}
        title="Projection"
        description="How fast you expect each part of the business, and its costs, to grow each year."
      />
      <Card>
        <CardHeader>
          <CardTitle>Yearly rates</CardTitle>
          <CardDescription>
            Whole percents a year. A minus number shrinks it. The projection starts from your
            books&apos; last twelve complete months.{" "}
            <Link href={`${base}/dashboard/projection`} className="underline underline-offset-4">
              See the projection
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ProjectionForm slug={tenant.slug} settings={settings} lines={revenue.lines} />
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {revenue.lines.map((l) => (
                <li key={l.id}>
                  {l.name}: {settings.line_growth[l.id] ?? settings.other_growth}% a year
                </li>
              ))}
              <li>Cost of goods: {settings.cogs_growth}% a year</li>
              <li>Running costs: {settings.fixed_growth}% a year</li>
              <li className="text-muted-foreground">An owner or admin can change these.</li>
            </ul>
          )}
        </CardContent>
      </Card>
    </>
  );
}
