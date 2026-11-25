import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { saveArticle } from "../../actions";
import { EntryForm } from "../../editor";

export const metadata: Metadata = { title: "New article" };

export default async function NewArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/manual/kb/new`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/helpdesk/manual/kb`;
  return (
    <>
      <PageHeader
        title="New article"
        description="For the team's eyes. Nothing here is shown to customers by itself."
        back={{ href: base, label: "Knowledge base" }}
      />
      <EntryForm
        action={saveArticle.bind(null, tenant.slug, null)}
        kind="article"
        initial={{ title: "", body: [] }}
        cancelHref={base}
        canEdit={entitlements.canWrite}
      />
    </>
  );
}
