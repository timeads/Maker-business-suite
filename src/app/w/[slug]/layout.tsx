import { notFound } from "next/navigation";
import { BillingBanner } from "@/components/shell/billing-banner";
import { Sidebar } from "@/components/shell/sidebar";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
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
  const [tenants, entitlements] = await Promise.all([
    listMyTenants(),
    getEntitlements(ctx.tenant.id),
  ]);

  return (
    <div className="flex min-h-dvh">
      <Sidebar
        tenant={ctx.tenant}
        tenants={tenants}
        userEmail={user.email}
        entitlements={entitlements}
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
