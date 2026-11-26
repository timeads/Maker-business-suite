import { requestJson } from "../connections/http";
import { graphUrl, isMetaAuthError, metaErrorMessage } from "../connections/providers/meta";
import type { Fetch } from "../connections/types";

/** Where a post goes. "instagram" is the feed (or a Reel, for a video); a Story is its own place. */
export type Channel = "facebook" | "instagram" | "instagram_story";
export type ChannelResult = { id: string } | { error: string };

export type PublishInput = {
  caption: string;
  /** Different words for one channel, where the post has them. */
  captions?: Partial<Record<Channel, string>>;
  /** Public addresses the photos can be fetched from, in order. Empty for words alone. */
  imageUrls: string[];
  /** A place's own copies of the photos (sized to fit it), in the same order, where it has them. */
  imagesFor?: Partial<Record<Channel, string[]>>;
  /** A video to post instead of photos. It goes out as a Reel on Instagram. */
  videoUrl?: string | null;
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

  const words = (channel: Channel) => input.captions?.[channel]?.trim() || input.caption;
  const photosFor = (channel: Channel) => {
    const own = input.imagesFor?.[channel];
    return (own?.length === input.imageUrls.length ? own : input.imageUrls).slice(0, 10);
  };
  const photos = input.imageUrls.slice(0, 10);

  /** Waits for Instagram to finish fetching whatever a container points at. */
  const ready = async (containerId: string, tries = 5, gap = 2_000) => {
    for (let attempt = 0; attempt < tries; attempt++) {
      const status = await requestJson<{ status_code?: string }>(
        fetchImpl,
        "Meta",
        `${graphUrl(`/${containerId}`)}?fields=status_code`,
        { headers: { Authorization: `Bearer ${input.pageToken}` } },
      );
      if (status.status_code === "ERROR") {
        throw new PermanentError(
          input.videoUrl
            ? "Instagram couldn't use that video. Reels need an MP4 or MOV between 3 seconds and 15 minutes"
            : "Instagram couldn't use that photo",
        );
      }
      if (status.status_code !== "IN_PROGRESS") return true;
      await wait(gap);
    }
    return false;
  };

  const senders: Record<Channel, () => Promise<string>> = {
    async facebook() {
      if (input.videoUrl) {
        // Facebook fetches the file itself and finishes preparing it after it answers.
        return (
          await post<{ id: string }>(`/${input.pageId}/videos`, {
            file_url: input.videoUrl,
            description: words("facebook"),
          })
        ).id;
      }
      if (photos.length === 1) {
        const photo = await post<{ id: string; post_id?: string }>(`/${input.pageId}/photos`, {
          url: photos[0],
          caption: words("facebook"),
        });
        return photo.post_id ?? photo.id;
      }
      if (photos.length > 1) {
        // Each photo is uploaded unseen, then one post gathers them.
        const attached: Record<string, string> = {};
        for (const [index, url] of photos.entries()) {
          const photo = await post<{ id: string }>(`/${input.pageId}/photos`, {
            url,
            published: "false",
          });
          attached[`attached_media[${index}]`] = JSON.stringify({ media_fbid: photo.id });
        }
        return (
          await post<{ id: string }>(`/${input.pageId}/feed`, {
            message: words("facebook"),
            ...attached,
          })
        ).id;
      }
      return (await post<{ id: string }>(`/${input.pageId}/feed`, { message: words("facebook") }))
        .id;
    },
    async instagram() {
      if (!input.instagramId) {
        throw new PermanentError("No Instagram account is linked to this Facebook Page");
      }
      const photos = photosFor("instagram");
      if (input.videoUrl) {
        const reel = await post<{ id: string }>(`/${input.instagramId}/media`, {
          media_type: "REELS",
          video_url: input.videoUrl,
          caption: words("instagram"),
        });
        // A video takes Instagram a while to prepare: up to about four minutes here.
        if (!(await ready(reel.id, 48, 5_000))) {
          throw new Error("Instagram is still preparing the video. We'll try again shortly");
        }
        return (
          await post<{ id: string }>(`/${input.instagramId}/media_publish`, {
            creation_id: reel.id,
          })
        ).id;
      }
      if (photos.length === 0) throw new PermanentError("Instagram posts need a photo or a video");
      let container: { id: string };
      if (photos.length === 1) {
        container = await post<{ id: string }>(`/${input.instagramId}/media`, {
          image_url: photos[0],
          caption: words("instagram"),
        });
      } else {
        // A swipe-through post: one container per photo, then one that holds them.
        const children: string[] = [];
        for (const url of photos) {
          const child = await post<{ id: string }>(`/${input.instagramId}/media`, {
            image_url: url,
            is_carousel_item: "true",
          });
          await ready(child.id);
          children.push(child.id);
        }
        container = await post<{ id: string }>(`/${input.instagramId}/media`, {
          media_type: "CAROUSEL",
          children: children.join(","),
          caption: words("instagram"),
        });
      }
      await ready(container.id);
      const published = await post<{ id: string }>(`/${input.instagramId}/media_publish`, {
        creation_id: container.id,
      });
      return published.id;
    },
    // A Story is one photo or one video, with no caption. It is published through the same
    // content publishing calls (and the same permission) as the feed, as media_type STORIES.
    async instagram_story() {
      if (!input.instagramId) {
        throw new PermanentError("No Instagram account is linked to this Facebook Page");
      }
      const photo = photosFor("instagram_story")[0];
      if (!input.videoUrl && !photo) {
        throw new PermanentError("An Instagram Story needs a photo or a video");
      }
      const story = await post<{ id: string }>(`/${input.instagramId}/media`, {
        media_type: "STORIES",
        ...(input.videoUrl ? { video_url: input.videoUrl } : { image_url: photo }),
      });
      const done = input.videoUrl ? await ready(story.id, 48, 5_000) : await ready(story.id);
      if (!done && input.videoUrl) {
        throw new Error("Instagram is still preparing the video. We'll try again shortly");
      }
      return (
        await post<{ id: string }>(`/${input.instagramId}/media_publish`, {
          creation_id: story.id,
        })
      ).id;
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
