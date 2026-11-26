import {
  LINKEDIN_URN,
  LinkedInError,
  createLinkedInClient,
  type LinkedInClient,
} from "../../linkedin/client";
import { ReconnectRequiredError, type Fetch } from "../../connections/types";
import { PENDING_LIMIT_MS, fetchOwnMedia, type NetworkSender, type TargetResult } from "./types";

export type LinkedInSendDeps = {
  /** The login's access token, through `getLoginToken`. */
  accessToken(tenantId: string, loginId: string): Promise<string>;
  client?(accessToken: string): LinkedInClient;
  fetchImpl?: Fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** How many times to ask whether a video is ready before leaving it to the next round. */
  checks?: number;
};

/** LinkedIn's refusal in plain words, and whether trying again might help. */
export function linkedinTrouble(err: unknown): { error: string; retry: boolean } {
  if (err instanceof ReconnectRequiredError) {
    return {
      error: "This LinkedIn login needs connecting again under Settings → Social accounts",
      retry: false,
    };
  }
  if (!(err instanceof LinkedInError)) {
    return { error: "Something went wrong on our side. We'll try again shortly", retry: true };
  }
  if (err.isAuthError) {
    return {
      error:
        "LinkedIn no longer accepts this login. Connect it again under Settings → Social accounts",
      retry: false,
    };
  }
  if (err.status === 403) {
    return {
      error:
        "LinkedIn says this login can't post here. For a company page, the person who connected must be one of its admins",
      retry: false,
    };
  }
  if (err.status === 429)
    return { error: "LinkedIn is busy. We'll try again shortly", retry: true };
  const said = err.words ? `: ${err.words}` : "";
  return {
    error: `LinkedIn wouldn't take it${said}`,
    retry: err.status === 0 || err.status >= 500,
  };
}

/**
 * Sends a post to one LinkedIn page or profile: its pictures or its video
 * first, sent as files from our own storage (nobody sees them until the post
 * names them), then the post itself, the one write anyone sees, asked once.
 * A video LinkedIn is still preparing is left "pending" with its id and
 * asked about next round; the post is only made once the video is ready.
 */
export function createLinkedInSender(deps: LinkedInSendDeps): NetworkSender {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const clientFor =
    deps.client ?? ((token: string) => createLinkedInClient(token, { fetchImpl: deps.fetchImpl }));

  async function publish(
    job: Parameters<NetworkSender>[0],
    client: LinkedInClient,
    media: { images?: string[]; video?: string | null },
  ): Promise<TargetResult | null> {
    if (!(await job.begin())) return null;
    try {
      return {
        id: await client.createPost({
          author: job.account.platform_id,
          words: job.words,
          ...media,
        }),
      };
    } catch (err) {
      if (err instanceof LinkedInError && err.applied === "unknown") {
        return {
          unsure:
            "We didn't hear back from LinkedIn, so we can't tell whether it posted. Look on LinkedIn, then tell us whether it's there",
        };
      }
      return linkedinTrouble(err);
    }
  }

  return async (job) => {
    const author = job.account.platform_id;
    if (!LINKEDIN_URN.test(author) || !job.account.login_id) {
      return { error: "This LinkedIn page needs connecting again", retry: false };
    }
    let client: LinkedInClient;
    try {
      client = clientFor(await deps.accessToken(job.tenantId, job.account.login_id));
    } catch (err) {
      return linkedinTrouble(err);
    }

    // A video sent last round: post once it's ready.
    const pending = typeof job.previous?.pending === "string" ? job.previous.pending : null;
    if (pending?.startsWith("video:")) {
      const video = pending.slice("video:".length);
      const since =
        typeof job.previous?.since === "string"
          ? job.previous.since
          : new Date(now()).toISOString();
      let status = "";
      try {
        status = await client.videoStatus(video);
      } catch {
        status = "";
      }
      if (status === "AVAILABLE") return publish(job, client, { video });
      if (status === "PROCESSING_FAILED" || status === "FAILED") {
        return { error: "LinkedIn couldn't use that video", retry: false };
      }
      if (now() - Date.parse(since) > PENDING_LIMIT_MS) {
        return { error: "LinkedIn took too long to get the video ready. Try again", retry: true };
      }
      return { pending, since };
    }

    try {
      if (job.video) {
        const bytes = await fetchOwnMedia(job.video.url, deps.fetchImpl);
        const video = await client.uploadVideo(author, bytes, job.video.mimeType);
        const since = new Date(now()).toISOString();
        for (let check = 0; check < (deps.checks ?? 12); check++) {
          await sleep(5_000);
          const status = await client.videoStatus(video).catch(() => "");
          if (status === "AVAILABLE") return publish(job, client, { video });
          if (status === "PROCESSING_FAILED" || status === "FAILED") {
            return { error: "LinkedIn couldn't use that video", retry: false };
          }
        }
        return { pending: `video:${video}`, since };
      }
      const images: string[] = [];
      for (const photo of job.photos.slice(0, 20)) {
        const bytes = await fetchOwnMedia(photo.url, deps.fetchImpl);
        images.push(await client.uploadImage(author, bytes, photo.mimeType));
      }
      return publish(job, client, { images });
    } catch (err) {
      // Anything before the post itself leaves nothing anyone sees: safe to try again.
      if (err instanceof LinkedInError) {
        const trouble = linkedinTrouble(err);
        return { ...trouble, retry: trouble.retry || err.applied === "unknown" };
      }
      return { error: "We couldn't read a photo or video from your assets just now", retry: true };
    }
  };
}
