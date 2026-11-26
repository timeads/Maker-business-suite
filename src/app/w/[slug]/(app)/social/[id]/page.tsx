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
import { Composer, DeletePostForm, RetryPostForm, SettleTargetForm } from "../composer";
import { socialAccess } from "../gate";
import { SendBackForm } from "../review-forms";
import { RedraftForm, RestoreVersionForm } from "../draft-forms";
import {
  REVIEW_LABELS,
  STATUS_LABELS,
  composerChoices,
  defaultSlot,
  loadDesignKit,
  localFields,
  photoReasons,
  postTargets,
  reviewFor,
} from "../shared";
import { NETWORK_LABELS, PLACE_RULES, isPlace, placeNetwork } from "@/lib/social/networks";
import { postTargets as postTargetsOf, targetLabel, type PostAccount } from "@/lib/social/targets";

export const metadata: Metadata = { title: "Post" };

const CHANNEL_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(PLACE_RULES).map(([place, rule]) => [place, rule.label]),
);

type Result = {
  id?: string;
  error?: string;
  pending?: string;
  unsure?: string;
  sending?: string;
  checked_by?: string;
};

/** What happened for one target, in a few words. */
function resultWords(result: Result | undefined): string {
  if (!result) return "waiting to go out";
  if (result.id && result.checked_by) return "posted (you checked)";
  if (result.id) return "posted";
  if (result.pending) return "sent, and still being prepared there";
  if (result.unsure) return result.unsure;
  if (result.sending) return "being sent";
  return result.error ?? "waiting to go out";
}

export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string; id: string }>;
  searchParams: Promise<{
    brand?: string;
    drafted?: string;
    rewritten?: string;
    restored?: string;
  }>;
}) {
  const { slug, id } = await params;
  const { brand: wanted, drafted, rewritten, restored } = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements, role } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data: post }, review, { data: versionRows }] = await Promise.all([
    supabase
      .from("social_posts")
      .select(
        "id, caption, captions, channels, account_ids, brand_id, status, scheduled_for, planned_for, published_at, results, error, asset_id, asset_ids, project_id, topic, ai_draft, review, review_note, slides, slide_asset_ids, target_options, photos_show, updated_at",
      )
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    reviewFor(supabase, tenant.id, role),
    supabase
      .from("social_post_versions")
      .select("id, caption, why, kept_at, has_slides:slides->v")
      .eq("tenant_id", tenant.id)
      .eq("post_id", id)
      .order("kept_at", { ascending: false })
      .limit(10),
  ]);
  if (!post) notFound();
  const versions = (versionRows ?? []) as {
    id: string;
    caption: string;
    why: "rewritten" | "replaced";
    kept_at: string;
    has_slides: unknown;
  }[];
  const accountIds = ((post.account_ids as string[] | null) ?? []).map(String);
  // The post's own brand, unless the person is switching it.
  const targets = await postTargets(
    supabase,
    tenant.id,
    wanted ?? (post.brand_id as string | null),
  );
  // Every account the post names, for the words on what went where (any brand, any state).
  const { data: namedRows } = accountIds.length
    ? await supabase
        .from("social_accounts")
        .select("id, network, platform_id, page_id, name, handle, tasks, active")
        .eq("tenant_id", tenant.id)
        .in("id", accountIds)
    : { data: [] };
  const named = (namedRows ?? []) as PostAccount[];
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
    loadDesignKit(supabase, tenant.id, targets.brand?.id),
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
  const results = (post.results ?? {}) as Record<string, Result>;
  const partlyOut = Object.values(results).some((r) => r.id);
  // Something with a network, or that we never heard back about, can't be changed either.
  const inFlight = Object.values(results).some(
    (r) => !r.id && (r.pending || r.unsure || r.sending),
  );
  const editable =
    entitlements.canWrite &&
    ["draft", "scheduled", "failed"].includes(post.status as string) &&
    !partlyOut &&
    !inFlight;
  const meantFor = (post.scheduled_for ?? post.planned_for) as string | null;
  const when = meantFor
    ? localFields(new Date(meantFor), tenant.timezone)
    : defaultSlot(new Date(), tenant.timezone);
  const captions = (post.captions ?? {}) as Record<string, string>;
  const targetsOut = postTargetsOf(
    { channels: ((post.channels as string[]) ?? []).filter(isPlace), account_ids: accountIds },
    named,
  ).flatMap((t) => t.places);
  const captionLabel = (key: string) => {
    const account = named.find((a) => a.id === key);
    return account ? targetLabel(`${key}:${account.network}`, named) : (CHANNEL_NAMES[key] ?? key);
  };

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
          {targetsOut
            .filter((t) => results[t.key]?.error)
            .map((t) => `${targetLabel(t.key, named)}: ${results[t.key].error}.`)
            .join(" ") || (inFlight ? "" : `${post.error}.`)}
          {partlyOut || inFlight
            ? " What was posted stays up and is never sent again."
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

      {(drafted || rewritten || restored) && (
        <FormMessage kind="success">
          {drafted
            ? "Claude drafted this from the project. Read it through and change anything you like; nothing goes out until you send it for review or schedule it."
            : rewritten
              ? "Claude wrote it again. What it said before is kept below, in case you'd rather have it back."
              : "The earlier version is back. What it said a moment ago is kept below."}
        </FormMessage>
      )}

      {editable && post.ai_draft && (post.status as string) === "draft" && (
        <Card>
          <CardHeader>
            <CardTitle>Claude&apos;s draft</CardTitle>
            {post.photos_show && (
              <CardDescription>
                What Claude saw in the photos:{" "}
                <span className="font-read">{post.photos_show as string}</span>
              </CardDescription>
            )}
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <RedraftForm
              slug={tenant.slug}
              postId={post.id as string}
              seen={post.updated_at as string}
              slides={Boolean(post.slides)}
            />
            {versions.length > 0 && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold">Earlier versions</p>
                <ul className="divide-border flex flex-col divide-y">
                  {versions.map((version) => (
                    <li key={version.id} className="flex flex-col gap-1 py-2">
                      <span className="text-muted-foreground text-xs">
                        {version.why === "rewritten"
                          ? "Before Claude wrote it again"
                          : "Before an earlier version was brought back"}
                        {" · "}
                        {
                          formatWhen(version.kept_at, version.kept_at, tenant.timezone).split(
                            " – ",
                          )[0]
                        }
                        {version.has_slides != null ? " · with slides" : ""}
                      </span>
                      <p className="font-read line-clamp-3 text-sm whitespace-pre-line">
                        {version.caption || "No caption"}
                      </p>
                      <RestoreVersionForm
                        slug={tenant.slug}
                        postId={post.id as string}
                        versionId={version.id}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {editable ? (
        <>
          <Card>
            <CardContent className="pt-6">
              <Composer
                key={post.updated_at as string}
                slug={tenant.slug}
                post={{
                  id: post.id as string,
                  caption: post.caption as string,
                  captions,
                  channels: post.channels as string[],
                  accountIds,
                  // The slides' own pictures are the slides; they aren't picked by hand.
                  photoIds: photoIds.filter(
                    (photoId) =>
                      !((post.slide_asset_ids as string[] | null) ?? []).includes(photoId),
                  ),
                  slides: ownDesign(post.slides, publicAssetUrl(`${tenant.id}/`)),
                  slidesFixed: post.status === "scheduled",
                  targetOptions: (post.target_options ?? {}) as Record<string, unknown>,
                  projectId: (post.project_id as string | null) ?? null,
                  topic: (post.topic as string | null) ?? null,
                  aiDraft: (post.ai_draft as string | null) ?? null,
                  planned: Boolean(post.planned_for),
                  day: when.day,
                  time: when.time,
                }}
                defaults={when}
                timezone={tenant.timezone}
                brands={targets.brands}
                brand={targets.brand}
                accounts={targets.accounts}
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
              {targetsOut.map((t) => targetLabel(t.key, named)).join(", ")}
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
            {Object.entries(captions)
              // A caption kept under both a place and its one account is the same words.
              .filter(([key]) => !(key in CHANNEL_NAMES) || accountIds.length === 0)
              .map(([key, words]) => (
                <div key={key}>
                  <p className="text-muted-foreground text-xs font-semibold">
                    On {captionLabel(key)}
                  </p>
                  <p className="font-read text-sm whitespace-pre-line">{words}</p>
                </div>
              ))}
            <ul className="text-muted-foreground flex flex-col gap-2 text-sm">
              {targetsOut.map((t) => (
                <li key={t.key} className="flex flex-col gap-1">
                  <span>
                    {targetLabel(t.key, named)}: {resultWords(results[t.key])}
                  </span>
                  {post.status === "failed" &&
                    entitlements.canWrite &&
                    !results[t.key]?.id &&
                    (results[t.key]?.unsure || results[t.key]?.sending) && (
                      <SettleTargetForm
                        slug={tenant.slug}
                        postId={post.id as string}
                        target={t.key}
                        network={NETWORK_LABELS[placeNetwork(t.place)] ?? "the network"}
                      />
                    )}
                </li>
              ))}
            </ul>
            {post.status === "failed" && (partlyOut || inFlight) && entitlements.canWrite && (
              <RetryPostForm slug={tenant.slug} postId={post.id as string} />
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
