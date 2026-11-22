import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { Composer } from "../composer";
import { socialAccess } from "../gate";
import { defaultSlot, socialChannels } from "../shared";

export const metadata: Metadata = { title: "New post" };

export default async function NewPostPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ day?: string }>;
}) {
  const { slug } = await params;
  const { day } = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/new`);
  if (!access.ok) return access.upsell;
  const { tenant } = access;
  const channels = await socialChannels(await createClient(), tenant.id);
  const suggestion = defaultSlot(new Date(), tenant.timezone);

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link
          href={`/w/${tenant.slug}/social`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Social
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">New post</h1>
      </header>
      <Card>
        <CardContent className="pt-6">
          <Composer
            slug={tenant.slug}
            defaults={{
              day: day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : suggestion.day,
              time: suggestion.time,
            }}
            timezone={tenant.timezone}
            facebook={channels.facebook}
            instagram={channels.instagram}
          />
        </CardContent>
      </Card>
    </>
  );
}
