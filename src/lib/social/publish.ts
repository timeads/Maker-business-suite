import { requestJson } from "../connections/http";
import { graphUrl, isMetaAuthError, metaErrorMessage } from "../connections/providers/meta";
import type { Fetch } from "../connections/types";

export type Channel = "facebook" | "instagram";
export type ChannelResult = { id: string } | { error: string };

export type PublishInput = {
  caption: string;
  /** A public address the photo can be fetched from, if the post has one. */
  imageUrl: string | null;
  channels: Channel[];
  /** Channels that already went out on an earlier try; never sent again. */
  alreadySent: Channel[];
  pageId: string;
  pageToken: string;
  instagramId: string | null;
};

export type PublishOutcome = {
  results: Partial<Record<Channel, ChannelResult>>;
  /** False when trying again can't help (access was removed, nothing to post to). */
  retry: boolean;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Sends one post to the channels it is meant for. Each channel stands alone:
 * one failing doesn't stop the other, and the caller records both answers.
 */
export async function publishPost(
  input: PublishInput,
  fetchImpl: Fetch = fetch,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<PublishOutcome> {
  const post = <T>(path: string, body: Record<string, string>) =>
    requestJson<T>(fetchImpl, "Meta", graphUrl(path), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.pageToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(body).toString(),
    });

  const senders: Record<Channel, () => Promise<string>> = {
    async facebook() {
      if (input.imageUrl) {
        const photo = await post<{ id: string; post_id?: string }>(`/${input.pageId}/photos`, {
          url: input.imageUrl,
          caption: input.caption,
        });
        return photo.post_id ?? photo.id;
      }
      return (await post<{ id: string }>(`/${input.pageId}/feed`, { message: input.caption })).id;
    },
    async instagram() {
      if (!input.instagramId) {
        throw new PermanentError("No Instagram account is linked to this Facebook Page");
      }
      if (!input.imageUrl) throw new PermanentError("Instagram posts need a photo");
      const container = await post<{ id: string }>(`/${input.instagramId}/media`, {
        image_url: input.imageUrl,
        caption: input.caption,
      });
      // Instagram fetches the photo itself; give it a moment if it asks for one.
      for (let attempt = 0; attempt < 5; attempt++) {
        const status = await requestJson<{ status_code?: string }>(
          fetchImpl,
          "Meta",
          `${graphUrl(`/${container.id}`)}?fields=status_code`,
          { headers: { Authorization: `Bearer ${input.pageToken}` } },
        );
        if (status.status_code === "ERROR") {
          throw new PermanentError("Instagram couldn't use that photo");
        }
        if (status.status_code !== "IN_PROGRESS") break;
        await wait(2_000);
      }
      const published = await post<{ id: string }>(`/${input.instagramId}/media_publish`, {
        creation_id: container.id,
      });
      return published.id;
    },
  };

  const outcome: PublishOutcome = { results: {}, retry: true };
  for (const channel of input.channels) {
    if (input.alreadySent.includes(channel)) continue;
    try {
      outcome.results[channel] = { id: await senders[channel]() };
    } catch (err) {
      if (err instanceof PermanentError || isMetaAuthError(err)) outcome.retry = false;
      outcome.results[channel] = {
        error: isMetaAuthError(err)
          ? "Facebook needs reconnecting on the Connections page"
          : metaErrorMessage(err),
      };
    }
  }
  return outcome;
}

class PermanentError extends Error {}
