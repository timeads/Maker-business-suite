import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { formatWhen } from "@/lib/bookings/slots";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { Composer, DeletePostForm } from "../composer";
import { socialAccess } from "../gate";
import { STATUS_LABELS, defaultSlot, localFields, socialChannels } from "../shared";

export const metadata: Metadata = { title: "Post" };

const CHANNEL_NAMES: Record<string, string> = { facebook: "Facebook", instagram: "Instagram" };

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();

  const supabase = await createClient();
  const [{ data: post }, channels] = await Promise.all([
    supabase
      .from("social_posts")
      .select(
        "id, caption, channels, status, scheduled_for, published_at, results, error, social_assets(id, storage_path, mime_type)",
      )
      .eq("id", id)
      .eq("tenant_id", tenant.id)
      .maybeSingle(),
    socialChannels(supabase, tenant.id),
  ]);
  if (!post) notFound();

  const asset = post.social_assets as unknown as {
    id: string;
    storage_path: string;
    mime_type: string;
  } | null;
  const results = (post.results ?? {}) as Record<string, { id?: string; error?: string }>;
  const partlyOut = Object.values(results).some((r) => r.id);
  const editable =
    entitlements.canWrite &&
    ["draft", "scheduled", "failed"].includes(post.status as string) &&
    !partlyOut;
  const when = post.scheduled_for
    ? localFields(new Date(post.scheduled_for as string), tenant.timezone)
    : defaultSlot(new Date(), tenant.timezone);
  const assetUrl = asset ? publicAssetUrl(asset.storage_path) : null;

  return (
    <>
      <header className="flex flex-col gap-2">
        <Link
          href={`/w/${tenant.slug}/social`}
          className="text-muted-foreground text-sm hover:underline"
        >
          ← Social
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {STATUS_LABELS[post.status as string]}
          {post.scheduled_for && post.status !== "draft"
            ? ` · ${formatWhen(post.scheduled_for as string, post.scheduled_for as string, tenant.timezone).split(" – ")[0]}`
            : ""}
        </h1>
      </header>

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

      {editable ? (
        <>
          <Card>
            <CardContent className="pt-6">
              <Composer
                slug={tenant.slug}
                post={{
                  id: post.id as string,
                  caption: post.caption as string,
                  channels: post.channels as string[],
                  assetId: asset?.id ?? null,
                  assetMime: asset?.mime_type ?? null,
                  assetUrl,
                  day: when.day,
                  time: when.time,
                }}
                defaults={when}
                timezone={tenant.timezone}
                facebook={channels.facebook}
                instagram={channels.instagram}
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
            {assetUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
              <img
                src={assetUrl}
                alt="The photo on this post"
                className="border-border max-h-80 w-fit rounded-md border object-contain"
              />
            )}
            <p className="text-sm whitespace-pre-line">{post.caption as string}</p>
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
