import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { formatWhen } from "@/lib/bookings/slots";
import { ownDesign } from "@/lib/brand/slides";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Composer, DeletePostForm } from "../composer";
import { socialAccess } from "../gate";
import { SendBackForm } from "../review-forms";
import {
  REVIEW_LABELS,
  STATUS_LABELS,
  composerChoices,
  defaultSlot,
  loadDesignKit,
  localFields,
  photoReasons,
  reviewFor,
  socialChannels,
} from "../shared";

export const metadata: Metadata = { title: "Post" };

const CHANNEL_NAMES: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  instagram_story: "Instagram Story",
};

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements, role } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data: post }, channels, review] = await Promise.all([
    supabase
      .from("social_posts")
      .select(
        "id, caption, captions, channels, status, scheduled_for, planned_for, published_at, results, error, asset_id, asset_ids, project_id, topic, ai_draft, review, review_note, slides, slide_asset_ids",
      )
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    socialChannels(supabase, tenant.id),
    reviewFor(supabase, tenant.id, role),
  ]);
  if (!post) notFound();
  const reviewState = (post.review as "waiting" | "sent_back" | null) ?? null;

  const photoIds = (
    (post.asset_ids as string[] | null)?.length
      ? (post.asset_ids as string[])
      : post.asset_id
        ? [post.asset_id as string]
        : []
  ) as string[];
  const [choices, kit] = await Promise.all([
    composerChoices(supabase, tenant.id, photoIds),
    loadDesignKit(supabase, tenant.id),
  ]);
  // On a draft Claude wrote, say why each photo that fits the topic is there.
  const topic = choices.plan.topics.find((t) => t.id === post.topic);
  const photoNotes =
    post.status === "draft" && post.ai_draft && topic
      ? photoReasons(choices.library, photoIds, `${topic.name} ${topic.about}`)
      : {};
  const photoUrls = photoIds.flatMap((photoId) => {
    const found = choices.library.find((photo) => photo.id === photoId);
    return found ? [found.url] : [];
  });
  const results = (post.results ?? {}) as Record<string, { id?: string; error?: string }>;
  const partlyOut = Object.values(results).some((r) => r.id);
  const editable =
    entitlements.canWrite &&
    ["draft", "scheduled", "failed"].includes(post.status as string) &&
    !partlyOut;
  const meantFor = (post.scheduled_for ?? post.planned_for) as string | null;
  const when = meantFor
    ? localFields(new Date(meantFor), tenant.timezone)
    : defaultSlot(new Date(), tenant.timezone);
  const captions = (post.captions ?? {}) as Partial<Record<"facebook" | "instagram", string>>;

  return (
    <>
      <PageHeader
        back={{ href: `/w/${tenant.slug}/social`, label: "Social" }}
        title={`${STATUS_LABELS[post.status as string]}${
          post.scheduled_for && post.status !== "draft"
            ? ` · ${formatWhen(post.scheduled_for as string, post.scheduled_for as string, tenant.timezone).split(" – ")[0]}`
            : ""
        }`}
      />

      {post.error && (
        <FormMessage>
          This post didn&apos;t fully go out.{" "}
          {(post.channels as string[])
            .filter((c) => results[c]?.error)
            .map((c) => `${CHANNEL_NAMES[c] ?? c}: ${results[c].error}.`)
            .join(" ") || `${post.error}.`}
          {partlyOut
            ? " The part that was posted stays up; write a new post for the rest."
            : " Fix it below and schedule it again."}
        </FormMessage>
      )}

      {reviewState && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>Review</CardTitle>
              <Badge tone={reviewState === "waiting" ? "waiting" : "bad"}>
                {REVIEW_LABELS[reviewState]}
              </Badge>
            </div>
            <CardDescription>
              {reviewState === "waiting"
                ? review.canApprove
                  ? "Read it through, change anything you like, then approve it below, or send it back with a note."
                  : "An approver will look at it, then schedule it or send it back with a note."
                : "It came back with a note. Change what it asks for, then send it for review again."}
            </CardDescription>
          </CardHeader>
          {(post.review_note || (reviewState === "waiting" && review.canApprove && editable)) && (
            <CardContent className="flex flex-col gap-4">
              {post.review_note && (
                <p className="bg-note font-read rounded-sm px-3 py-2 text-sm whitespace-pre-line">
                  {post.review_note as string}
                </p>
              )}
              {reviewState === "waiting" && review.canApprove && editable && (
                <SendBackForm slug={tenant.slug} postId={post.id as string} />
              )}
            </CardContent>
          )}
        </Card>
      )}

      {editable ? (
        <>
          <Card>
            <CardContent className="pt-6">
              <Composer
                slug={tenant.slug}
                post={{
                  id: post.id as string,
                  caption: post.caption as string,
                  captions,
                  channels: post.channels as string[],
                  // The slides' own pictures are the slides; they aren't picked by hand.
                  photoIds: photoIds.filter(
                    (photoId) =>
                      !((post.slide_asset_ids as string[] | null) ?? []).includes(photoId),
                  ),
                  slides: ownDesign(post.slides, publicAssetUrl(`${tenant.id}/`)),
                  slidesFixed: post.status === "scheduled",
                  projectId: (post.project_id as string | null) ?? null,
                  topic: (post.topic as string | null) ?? null,
                  aiDraft: (post.ai_draft as string | null) ?? null,
                  planned: Boolean(post.planned_for),
                  day: when.day,
                  time: when.time,
                }}
                defaults={when}
                timezone={tenant.timezone}
                facebook={channels.facebook}
                instagram={channels.instagram}
                library={choices.library}
                projects={choices.projects}
                topics={choices.topics}
                kit={kit}
                photoNotes={photoNotes}
                review={{ ...review, state: reviewState }}
              />
            </CardContent>
          </Card>
          <DeletePostForm slug={tenant.slug} postId={post.id as string} />
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>What was posted</CardTitle>
            <CardDescription>
              {(post.channels as string[]).map((c) => CHANNEL_NAMES[c] ?? c).join(" and ")}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {photoUrls.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {photoUrls.map((url, index) => (
                  // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
                  <img
                    key={url}
                    src={url}
                    alt={`Photo ${index + 1} on this post`}
                    className="border-border max-h-64 w-fit rounded-md border object-contain"
                  />
                ))}
              </div>
            )}
            <p className="font-read text-sm whitespace-pre-line">{post.caption as string}</p>
            {Object.entries(captions).map(([channel, words]) => (
              <div key={channel}>
                <p className="text-muted-foreground text-xs font-semibold">
                  On {CHANNEL_NAMES[channel] ?? channel}
                </p>
                <p className="font-read text-sm whitespace-pre-line">{words}</p>
              </div>
            ))}
            <ul className="text-muted-foreground text-sm">
              {(post.channels as string[]).map((c) => (
                <li key={c}>
                  {CHANNEL_NAMES[c] ?? c}:{" "}
                  {results[c]?.id ? "posted" : (results[c]?.error ?? "waiting to go out")}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
