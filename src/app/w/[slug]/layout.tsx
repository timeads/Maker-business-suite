import { notFound } from "next/navigation";
import { BillingBanner } from "@/components/shell/billing-banner";
import { Sidebar } from "@/components/shell/sidebar";
import { loadAttention } from "@/lib/attention";
import { requireUser } from "@/lib/auth";
import { daysFromNow } from "@/lib/bookings/slots";
import {
  APPEARANCE_KEY,
  brandThemeVars,
  brandThemeVarsDark,
  parseAppearance,
} from "@/lib/brand/appearance";
import { BRAND_MODULE, KIT_KEY, parseBrandKit } from "@/lib/brand/kit";
import { getEntitlements } from "@/lib/entitlements";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext, listMyTenants } from "@/lib/tenants";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}`);
  const ctx = await getTenantContext(slug, user.id);
  // Not a member looks exactly like "doesn't exist".
  if (!ctx) notFound();
  const supabase = await createClient();
  const [tenants, entitlements, { data: brandRows }] = await Promise.all([
    listMyTenants(),
    getEntitlements(ctx.tenant.id),
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", ctx.tenant.id)
      .eq("module", BRAND_MODULE)
      .in("key", [KIT_KEY, APPEARANCE_KEY]),
  ]);
  const attention = await loadAttention(
    supabase,
    ctx.tenant.id,
    (key) => entitlements.can(`module.${key}`),
    daysFromNow(0),
  ).catch(() => ({}));
  const setting = (key: string) => (brandRows ?? []).find((row) => row.key === key)?.body;
  const look = parseAppearance(setting(APPEARANCE_KEY));
  const kit = look.brand_colors ? parseBrandKit(setting(KIT_KEY)) : null;
  // Brand colours for a known mode are set here. For "match my device" the
  // light set is used: the text shades differ between modes and the server
  // can't know which the device will pick.
  const brandVars = look.mode === "dark" ? brandThemeVarsDark(kit) : brandThemeVars(kit);

  return (
    <div
      className="tuft-scope flex min-h-dvh"
      data-theme={look.mode}
      style={brandVars as React.CSSProperties}
    >
      <Sidebar
        tenant={ctx.tenant}
        tenants={tenants}
        userEmail={user.email}
        entitlements={entitlements}
        attention={attention}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <BillingBanner
          entitlements={entitlements}
          billingHref={`/w/${ctx.tenant.slug}/settings/billing`}
          timeZone={ctx.tenant.timezone}
          canManage={canManage(ctx.role)}
        />
        {children}
      </div>
    </div>
  );
}
