import { CHANNELS_KEY, parseChannelSettings } from "@/lib/helpdesk/social/channels";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { BillingBanner } from "@/components/shell/billing-banner";
import { HubRail } from "@/components/shell/hub-rail";
import { MenuPanel } from "@/components/shell/menu-panel";
import { NavProvider } from "@/components/shell/nav-context";
import { isPlatformAdmin } from "@/lib/admin/platform";
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
import { googleMailConfigured } from "@/lib/connections/providers/google-mail";
import { getEntitlements } from "@/lib/entitlements";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { MANUAL_KEY, parseManual } from "@/lib/helpdesk/manual/config";
import { PANEL_COOKIE, buildNav } from "@/lib/nav/model";
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
  const [tenants, platformAdmin, entitlements, jar, { data: brandRows }] = await Promise.all([
    listMyTenants(),
    isPlatformAdmin(),
    getEntitlements(ctx.tenant.id),
    cookies(),
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
  // Stock's menu has a Michaels row only once a seller account is connected.
  // One small read, as the member, and only where the plan has Stock.
  const { data: michaels } = entitlements.can("module.stock")
    ? await supabase
        .from("connections")
        .select("status")
        .eq("tenant_id", ctx.tenant.id)
        .eq("provider", "michaels")
        .maybeSingle()
    : { data: null };
  // The help desk's manual goes by the workspace's own name for it in the menu,
  // and "Instagram & Facebook" is a place only where those messages are on.
  const { data: deskRows } = entitlements.can("module.helpdesk")
    ? await supabase
        .from("configs")
        .select("key, body")
        .eq("tenant_id", ctx.tenant.id)
        .eq("module", HELPDESK_MODULE)
        .in("key", [MANUAL_KEY, CHANNELS_KEY])
    : { data: null };
  const deskSetting = (key: string) => (deskRows ?? []).find((row) => row.key === key)?.body;
  const manual = { body: deskSetting(MANUAL_KEY) };
  const channels = parseChannelSettings(deskSetting(CHANNELS_KEY));
  // The rail and every tool's menu, decided in one place for this person.
  const tools = buildNav(
    {
      can: (feature) => entitlements.can(feature),
      manager: canManage(ctx.role),
      canWrite: entitlements.canWrite,
      gmailOrders: googleMailConfigured(),
      michaels: michaels?.status === "active" || michaels?.status === "needs_reconnect",
      manualName: parseManual(manual?.body).name,
      socialInbox:
        channels.instagram ||
        channels.facebook ||
        channels.instagram_comments ||
        channels.facebook_comments,
    },
    attention,
  );
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
      <NavProvider
        slug={ctx.tenant.slug}
        tools={tools}
        startCollapsed={jar.get(PANEL_COOKIE)?.value === "closed"}
      >
        <HubRail
          tenant={ctx.tenant}
          tenants={tenants}
          userEmail={user.email}
          platformAdmin={platformAdmin}
        />
        <MenuPanel />
        <div className="flex min-w-0 flex-1 flex-col">
          <BillingBanner
            entitlements={entitlements}
            billingHref={`/w/${ctx.tenant.slug}/settings/billing`}
            timeZone={ctx.tenant.timezone}
            canManage={canManage(ctx.role)}
          />
          {children}
        </div>
      </NavProvider>
    </div>
  );
}
