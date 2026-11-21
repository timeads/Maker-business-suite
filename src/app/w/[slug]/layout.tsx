import { notFound } from "next/navigation";
import { Sidebar } from "@/components/shell/sidebar";
import { requireUser } from "@/lib/auth";
import { getTenantContext, listMyTenants } from "@/lib/tenants";

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
  const tenants = await listMyTenants();

  return (
    <div className="flex min-h-dvh flex-col md:flex-row">
      <Sidebar tenant={ctx.tenant} tenants={tenants} userEmail={user.email} />
      <main className="min-w-0 flex-1 px-4 py-8 md:px-10">
        <div className="mx-auto flex max-w-4xl flex-col gap-8">{children}</div>
      </main>
    </div>
  );
}
