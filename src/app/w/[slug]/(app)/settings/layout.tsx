import { notFound } from "next/navigation";
import { SettingsNav } from "@/components/settings/settings-nav";
import { PageHeader } from "@/components/ui/page-header";
import { requireUser } from "@/lib/auth";
import { googleMailConfigured } from "@/lib/connections/providers/google-mail";
import { getEntitlements } from "@/lib/entitlements";
import { settingsNav } from "@/lib/settings/nav";
import { canManage, getTenantContext } from "@/lib/tenants";

/**
 * Workspace Settings: the one place every setting lives. The list on the left
 * holds the workspace's own sections and one entry per tool on the plan; which
 * of them this person sees is decided by `settingsNav()`. Each page still
 * checks for itself who may open and change it.
 */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const entitlements = await getEntitlements(ctx.tenant.id);
  const groups = settingsNav({
    can: (feature) => entitlements.can(feature),
    manager: canManage(ctx.role),
    canWrite: entitlements.canWrite,
    gmailOrders: googleMailConfigured(),
  });

  return (
    <>
      <PageHeader
        title="Settings"
        description="Everything you set up once: your workspace, and each of your tools."
      />
      <div className="flex flex-col gap-5 md:flex-row md:items-start md:gap-8">
        <SettingsNav slug={ctx.tenant.slug} groups={groups} />
        <div className="flex min-w-0 flex-1 flex-col gap-6">{children}</div>
      </div>
    </>
  );
}
