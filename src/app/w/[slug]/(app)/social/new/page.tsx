import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { Composer } from "../composer";
import { socialAccess } from "../gate";
import { composerChoices, defaultSlot, loadDesignKit, postTargets, reviewFor } from "../shared";

export const metadata: Metadata = { title: "New post" };

export default async function NewPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    day?: string;
    time?: string;
    topic?: string;
    project?: string;
    brand?: string;
  }>;
}) {
  const { slug } = await params;
  const { day, time, topic, project, brand: wanted } = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/new`);
  if (!access.ok) return access.upsell;
  const { tenant, role } = access;
  const supabase = await createClient();
  const [targets, choices, review] = await Promise.all([
    postTargets(supabase, tenant.id, wanted),
    composerChoices(supabase, tenant.id, []),
    reviewFor(supabase, tenant.id, role),
  ]);
  // The slides are drawn in the brand picked.
  const kit = await loadDesignKit(supabase, tenant.id, targets.brand?.id);
  const suggestion = defaultSlot(new Date(), tenant.timezone);

  return (
    <>
      <PageHeader back={{ href: `/w/${tenant.slug}/social`, label: "Social" }} title="New post" />
      <Card>
        <CardContent className="pt-6">
          <Composer
            slug={tenant.slug}
            defaults={{
              day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : suggestion.day,
              time: time && /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : suggestion.time,
              topic: topic ?? null,
              projectId: project ?? null,
            }}
            library={choices.library}
            projects={choices.projects}
            topics={choices.topics}
            timezone={tenant.timezone}
            brands={targets.brands}
            brand={targets.brand}
            accounts={targets.accounts}
            kit={kit}
            review={{ ...review, state: null }}
          />
        </CardContent>
      </Card>
    </>
  );
}
