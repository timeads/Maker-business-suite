import type { SupabaseClient } from "@supabase/supabase-js";
import { accountAllows, canPost } from "../connections/meta-access";
import { pageTokenOf } from "../connections/meta-token";
import type { StoredToken } from "../connections/tokens";
import { ReconnectRequiredError } from "../connections/types";
import { withTenant } from "../supabase/admin";
import { publishPost, type Channel, type ChannelResult, type PublishOutcome } from "./publish";
import { placeNetwork, postTargets, targetLabel, type PostAccount } from "./targets";

export { placeNetwork, postTargets, targetKey, targetLabel, type PostAccount } from "./targets";

type DuePost = {
  id: string;
  tenant_id: string;
  caption: string;
  asset_id: string | null;
  asset_ids?: string[] | null;
  /** A caption of its own, by account id (or, from before accounts, by place). */
  captions?: Record<string, string> | null;
  /** A place's own sized copies, one per photo in order: {"instagram": [ids]}. */
  channel_media?: Partial<Record<Channel, string[]>> | null;
  channels: Channel[];
  /** The accounts it goes to; empty for a post from before accounts (it goes by places alone). */
  account_ids?: string[] | null;
  /** Each target's answer: "<account id>:<place>" (or a bare place, before accounts). */
  results: Record<string, ChannelResult>;
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

const failTargets = (keys: string[], error: string): PublishOutcome => ({
  retry: false,
  results: Object.fromEntries(keys.map((key) => [key, { error }])),
});

const sent = (post: DuePost, key: string) => "id" in (post.results[key] ?? {});

async function send(
  post: DuePost,
  deps: SocialWorkerDeps,
): Promise<PublishOutcome & { accounts: PostAccount[] }> {
  // Posts saved before several photos were possible only have the one.
  const assetIds = post.asset_ids?.length ? post.asset_ids : post.asset_id ? [post.asset_id] : [];
  const copyIds = Object.values(post.channel_media ?? {}).flatMap((ids) =>
    Array.isArray(ids) ? ids.map(String) : [],
  );
  const accountIds = post.account_ids ?? [];
  const { connection, storagePaths, videoPath, copies, accounts } = await withTenant(
    post.tenant_id,
    async (scope) => {
      const [{ data: connection }, { data: assets }, { data: accountRows }] = await Promise.all([
        scope.select("connections", "metadata, scopes").eq("provider", "meta").maybeSingle(),
        assetIds.length || copyIds.length
          ? scope
              .select("social_assets", "id, storage_path, mime_type, fitted_from, fitted_for")
              .in("id", [...new Set([...assetIds, ...copyIds])])
          : Promise.resolve({ data: [] }),
        accountIds.length
          ? scope
              .select(
                "social_accounts",
                "id, network, platform_id, page_id, name, handle, tasks, active",
              )
              .in("id", accountIds)
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
        connection: connection as {
          metadata?: { instagram_id?: string | null };
          scopes?: unknown;
        } | null,
        // In the order the person arranged them.
        storagePaths: video
          ? []
          : assetIds.flatMap((id) => (paths.has(id) ? [paths.get(id)!] : [])),
        videoPath: video?.storage_path ?? null,
        copies: new Map(all.filter((asset) => asset.fitted_from).map((asset) => [asset.id, asset])),
        accounts: (accountRows ?? []) as unknown as PostAccount[],
      };
    },
    deps.admin,
  );
  const targets = postTargets(post, accounts);
  const waitingKeys = targets.flatMap((t) =>
    t.places.filter((p) => !sent(post, p.key)).map((p) => p.key),
  );
  const outcome = (o: PublishOutcome) => ({ ...o, accounts });

  if (!(await deps.moduleOpen(post.tenant_id))) {
    return outcome(
      failTargets(waitingKeys, "Social isn't part of this workspace's plan right now"),
    );
  }
  let stored: StoredToken;
  try {
    stored = await deps.getToken(post.tenant_id);
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return outcome(failTargets(waitingKeys, "Facebook needs connecting on the Connections page"));
    }
    throw err;
  }
  const scopes = grantedScopes(connection?.scopes);
  const imagesFor = videoPath
    ? {}
    : placeImages(assetIds, storagePaths, post.channel_media ?? {}, copies);
  const results: Record<string, ChannelResult> = {};
  let retry = false;
  let anyFailed = false;
  // Each account stands alone: one failing never stops another, and each
  // answer is kept under its own target.
  for (const { account, places } of targets) {
    const waiting = places.filter((p) => !sent(post, p.key));
    if (waiting.length === 0) continue;
    const fail = (error: string) => {
      anyFailed = true;
      for (const p of waiting) results[p.key] = { error };
    };
    // A connection made for the help desk alone has no permission to publish.
    // A Story is published with the same Instagram permission as the feed.
    if (scopes !== null && waiting.some((p) => !canPost(placeNetwork(p.place), scopes))) {
      fail(
        "Facebook wasn't given permission to post. Open Social and press “Allow posting on Facebook”",
      );
      continue;
    }
    if (account && !account.active) {
      fail("This account isn't in use any more. Choose it again under Settings → Social accounts");
      continue;
    }
    if (account && !accountAllows("posting", account.tasks)) {
      fail("Facebook says whoever connected it can't post on this Page");
      continue;
    }
    const pageId = account ? account.page_id : stored.externalAccountId;
    const pageToken = pageId ? pageTokenOf(stored, pageId) : null;
    if (!pageId || !pageToken) {
      fail("This Page needs connecting again on the Connections page");
      continue;
    }
    const instagramId = account
      ? account.network === "instagram"
        ? account.platform_id
        : null
      : (connection?.metadata?.instagram_id ?? null);
    const words = (place: Channel) =>
      (account ? post.captions?.[account.id] : undefined) ??
      post.captions?.[place === "instagram_story" ? "instagram" : place];
    const tried = await deps.publish({
      caption: post.caption,
      captions: Object.fromEntries(
        waiting.flatMap(({ place }) => {
          const own = words(place);
          return own ? [[place, own]] : [];
        }),
      ),
      imageUrls: storagePaths.map(publicAssetUrl),
      imagesFor: Object.fromEntries(
        Object.entries(imagesFor).map(([place, paths]) => [place, paths.map(publicAssetUrl)]),
      ),
      videoUrl: videoPath ? publicAssetUrl(videoPath) : null,
      channels: waiting.map((p) => p.place),
      alreadySent: [],
      pageId,
      pageToken,
      instagramId,
    });
    for (const p of waiting) {
      const answer = tried.results[p.place];
      if (answer) results[p.key] = answer;
      if (!answer || "error" in answer) anyFailed = true;
    }
    if (tried.retry) retry = true;
  }
  return outcome({ results, retry: anyFailed ? retry : true });
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
    let outcome: PublishOutcome & { accounts: PostAccount[] };
    try {
      outcome = await send(post, deps);
    } catch (err) {
      // Something on our side: leave the post claimed so it is retried later.
      console.error(`social post ${post.id}: ${err instanceof Error ? err.message : err}`);
      outcome = { results: {}, retry: true, accounts: [] };
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
        .map(
          ([key, result]) =>
            `${targetLabel(key, outcome.accounts)}: ${(result as { error: string }).error}`,
        )
        .join("; ");
      await deps.notifyFailed(post.tenant_id, post.caption, reason || "It couldn't be sent");
    }
  }
  return posts.length;
}
