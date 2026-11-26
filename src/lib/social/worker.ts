import type { SupabaseClient } from "@supabase/supabase-js";
import { canPost } from "../connections/meta-access";
import type { StoredToken } from "../connections/tokens";
import { ReconnectRequiredError } from "../connections/types";
import { withTenant } from "../supabase/admin";
import { publishPost, type Channel, type ChannelResult, type PublishOutcome } from "./publish";

type DuePost = {
  id: string;
  tenant_id: string;
  caption: string;
  asset_id: string | null;
  asset_ids?: string[] | null;
  captions?: Partial<Record<Channel, string>> | null;
  /** A place's own sized copies, one per photo in order: {"instagram": [ids]}. */
  channel_media?: Partial<Record<Channel, string[]>> | null;
  channels: Channel[];
  results: Partial<Record<Channel, ChannelResult>>;
};

export type SocialWorkerDeps = {
  admin: SupabaseClient;
  moduleOpen(tenantId: string): Promise<boolean>;
  getToken(tenantId: string): Promise<StoredToken>;
  publish: typeof publishPost;
  /** Tells the workspace's owners a post didn't go out. */
  notifyFailed(tenantId: string, caption: string, reason: string): Promise<void>;
};

export const publicAssetUrl = (storagePath: string) =>
  `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "")}/storage/v1/object/public/social/${storagePath}`;

/** The connection's granted permissions, or null when they aren't on record. */
const grantedScopes = (raw: unknown): string[] | null =>
  Array.isArray(raw) ? raw.map(String) : null;

const failAll = (post: DuePost, error: string): PublishOutcome => ({
  retry: false,
  results: Object.fromEntries(
    post.channels.filter((c) => !("id" in (post.results[c] ?? {}))).map((c) => [c, { error }]),
  ),
});

async function send(post: DuePost, deps: SocialWorkerDeps): Promise<PublishOutcome> {
  if (!(await deps.moduleOpen(post.tenant_id))) {
    return failAll(post, "Social isn't part of this workspace's plan right now");
  }
  let stored: StoredToken;
  try {
    stored = await deps.getToken(post.tenant_id);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return failAll(post, "Facebook needs connecting on the Connections page");
    }
    throw err;
  }
  // Posts saved before several photos were possible only have the one.
  const assetIds = post.asset_ids?.length ? post.asset_ids : post.asset_id ? [post.asset_id] : [];
  const copyIds = Object.values(post.channel_media ?? {}).flatMap((ids) =>
    Array.isArray(ids) ? ids.map(String) : [],
  );
  const { instagramId, storagePaths, videoPath, scopes, copies } = await withTenant(
    post.tenant_id,
    async (scope) => {
      const [{ data: connection }, { data: assets }] = await Promise.all([
        scope.select("connections", "metadata, scopes").eq("provider", "meta").maybeSingle(),
        assetIds.length || copyIds.length
          ? scope
              .select("social_assets", "id, storage_path, mime_type, fitted_from, fitted_for")
              .in("id", [...new Set([...assetIds, ...copyIds])])
          : Promise.resolve({ data: [] }),
      ]);
      const all = (assets ?? []) as unknown as {
        id: string;
        storage_path: string;
        mime_type: string;
        fitted_from: string | null;
        fitted_for: string | null;
      }[];
      const rows = all.filter((asset) => assetIds.includes(asset.id));
      const paths = new Map(rows.map((asset) => [asset.id, asset.storage_path]));
      const video = rows.find((asset) => asset.mime_type.startsWith("video/"));
      return {
        instagramId:
          (connection as { metadata?: { instagram_id?: string | null } } | null)?.metadata
            ?.instagram_id ?? null,
        // In the order the person arranged them.
        storagePaths: video
          ? []
          : assetIds.flatMap((id) => (paths.has(id) ? [paths.get(id)!] : [])),
        videoPath: video?.storage_path ?? null,
        scopes: grantedScopes((connection as { scopes?: unknown } | null)?.scopes),
        copies: new Map(all.filter((asset) => asset.fitted_from).map((asset) => [asset.id, asset])),
      };
    },
    deps.admin,
  );
  // A connection made for the help desk alone has no permission to publish.
  const waiting = post.channels.filter((c) => !("id" in (post.results[c] ?? {})));
  // A Story is published with the same Instagram permission as the feed.
  if (
    scopes !== null &&
    waiting.some((c) => !canPost(c === "facebook" ? "facebook" : "instagram", scopes))
  ) {
    return failAll(
      post,
      "Facebook wasn't given permission to post. Open Social and press “Allow posting on Facebook”",
    );
  }
  const imagesFor = videoPath
    ? {}
    : placeImages(assetIds, storagePaths, post.channel_media ?? {}, copies);
  return deps.publish({
    caption: post.caption,
    captions: post.captions ?? {},
    imageUrls: storagePaths.map(publicAssetUrl),
    imagesFor: Object.fromEntries(
      Object.entries(imagesFor).map(([place, paths]) => [place, paths.map(publicAssetUrl)]),
    ),
    videoUrl: videoPath ? publicAssetUrl(videoPath) : null,
    channels: post.channels,
    alreadySent: post.channels.filter((c) => "id" in (post.results[c] ?? {})),
    pageId: stored.externalAccountId,
    pageToken: stored.token.access_token,
    instagramId,
  });
}

/**
 * Each place's own copies of a post's photos, as storage paths in the post's order. A place
 * gets its copies only when every one is really that photo's copy for that place (the database
 * checked them when the post was scheduled; this is the same rule again); otherwise it gets
 * the photos themselves.
 */
export function placeImages(
  assetIds: string[],
  storagePaths: string[],
  channelMedia: Partial<Record<Channel, string[]>>,
  copies: Map<
    string,
    { storage_path: string; fitted_from: string | null; fitted_for: string | null }
  >,
): Partial<Record<Channel, string[]>> {
  const out: Partial<Record<Channel, string[]>> = {};
  if (storagePaths.length !== assetIds.length) return out;
  for (const [place, ids] of Object.entries(channelMedia) as [Channel, string[]][]) {
    if (!Array.isArray(ids) || ids.length !== assetIds.length) continue;
    const paths = ids.map((id, index) => {
      if (id === assetIds[index]) return storagePaths[index];
      const copy = copies.get(id);
      return copy && copy.fitted_from === assetIds[index] && copy.fitted_for === place
        ? copy.storage_path
        : null;
    });
    if (paths.every((path): path is string => Boolean(path))) out[place] = paths;
  }
  return out;
}

/** Publishes every scheduled post whose time has come. Returns how many it handled. */
export async function publishDuePosts(deps: SocialWorkerDeps): Promise<number> {
  const { data, error } = await deps.admin.rpc("claim_due_social_posts", { p_limit: 10 });
  if (error) throw new Error(`Could not claim social posts: ${error.message}`);
  const posts = (data ?? []) as DuePost[];
  for (const post of posts) {
    let outcome: PublishOutcome;
    try {
      outcome = await send(post, deps);
    } catch (err) {
      // Something on our side: leave the post claimed so it is retried later.
      console.error(`social post ${post.id}: ${err instanceof Error ? err.message : err}`);
      outcome = { results: {}, retry: true };
    }
    const { data: status, error: finishError } = await deps.admin.rpc("finish_social_post", {
      p_post_id: post.id,
      p_results: outcome.results,
      p_retry: outcome.retry,
    });
    if (finishError) {
      console.error(`could not record social post ${post.id}: ${finishError.message}`);
      continue;
    }
    console.log(`social post ${post.id}: ${status}`);
    if (status === "failed") {
      const reason = Object.entries(outcome.results)
        .filter(([, result]) => result && "error" in result)
        .map(([channel, result]) => `${channel}: ${(result as { error: string }).error}`)
        .join("; ");
      await deps.notifyFailed(post.tenant_id, post.caption, reason || "It couldn't be sent");
    }
  }
  return posts.length;
}
