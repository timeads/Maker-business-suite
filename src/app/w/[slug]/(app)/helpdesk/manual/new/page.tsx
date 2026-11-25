import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { loadManualConfig } from "@/lib/helpdesk/manual/data";
import { createClient } from "@/lib/supabase/server";
import { saveTopic } from "../actions";
import { EntryForm } from "../editor";

export const metadata: Metadata = { title: "New topic" };

export default async function NewTopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/manual/new`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const config = await loadManualConfig(await createClient(), tenant.id);
  const base = `/w/${tenant.slug}/helpdesk/manual`;
  return (
    <>
      <PageHeader
        title="New topic"
        description="Something the team has learned to answer, written in your own words."
        back={{ href: base, label: config.name }}
      />
      <EntryForm
        action={saveTopic.bind(null, tenant.slug, null)}
        kind="topic"
        initial={{ title: "", summary: "", body: [] }}
        facets={config.facets}
        headings={config.sections}
        cancelHref={base}
        canEdit={entitlements.canWrite}
      />
    </>
  );
}
