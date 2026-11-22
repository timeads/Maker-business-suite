import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { loadStock } from "../data";
import { StockSettingsForm } from "../forms";
import { stockAccess } from "../gate";
import { StockTabs } from "../tabs";

export const metadata: Metadata = { title: "Stock settings" };

export default async function StockSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await stockAccess(slug, `/w/${slug}/stock/settings`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const { settings, link } = await loadStock(await createClient(), tenant);
  const synced = link.lastSyncedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: tenant.timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(link.lastSyncedAt))
    : null;

  return (
    <>
      <PageHeader
        title="Stock"
        description="How far ahead to plan, and how your shop is kept in step."
      />
      <StockTabs slug={tenant.slug} />
      <Card>
        <CardHeader>
          <CardTitle>Planning</CardTitle>
          <CardDescription>
            {link.connected
              ? `Counts and sales come from your shop${synced ? `; last read ${synced}` : ""}.`
              : "Connect your shop under Connections to bring in your items and sales."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canManage(role) && entitlements.canWrite ? (
            <StockSettingsForm slug={tenant.slug} settings={settings} canPush={link.canPush} />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can change these settings.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
