import type { Metadata } from "next";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { createClient } from "@/lib/supabase/server";
import { Composer } from "../composer";
import { socialAccess } from "../gate";
import { composerChoices, defaultSlot, socialChannels } from "../shared";

export const metadata: Metadata = { title: "New post" };

export default async function NewPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ day?: string; time?: string; topic?: string; project?: string }>;
}) {
  const { slug } = await params;
  const { day, time, topic, project } = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/new`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const supabase = await createClient();
  const [channels, choices] = await Promise.all([
    socialChannels(supabase, tenant.id),
    composerChoices(supabase, tenant.id, []),
  ]);
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
            facebook={channels.facebook}
            instagram={channels.instagram}
          />
        </CardContent>
      </Card>
    </>
  );
}
