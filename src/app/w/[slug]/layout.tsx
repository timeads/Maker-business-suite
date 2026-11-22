import Link from "next/link";
import { notFound } from "next/navigation";
import { BillingBanner } from "@/components/shell/billing-banner";
import { Sidebar } from "@/components/shell/sidebar";
import { requireUser } from "@/lib/auth";
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
  const [tenants, entitlements, { data: pendingInvites }] = await Promise.all([
    listMyTenants(),
    getEntitlements(ctx.tenant.id),
    supabase.rpc("my_pending_invites"),
  ]);
  const inviteCount = Array.isArray(pendingInvites) ? pendingInvites.length : 0;

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
        <main className="min-w-0 flex-1 px-4 pt-6 pb-24 md:px-8 md:pt-8 md:pb-12">
          <div className="mx-auto flex max-w-5xl flex-col gap-6">
            {inviteCount > 0 && (
              <p
                role="status"
                className="border-border bg-muted rounded-md border px-3 py-2 text-sm"
              >
                You&apos;ve been invited to{" "}
                {inviteCount === 1 ? "another workspace" : `${inviteCount} other workspaces`}.{" "}
                <Link href="/app" className="font-medium underline underline-offset-4">
                  View invite{inviteCount === 1 ? "" : "s"}
                </Link>
              </p>
            )}
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
