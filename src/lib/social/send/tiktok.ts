import { TikTokError, createTikTokClient, type TikTokClient } from "../../tiktok/client";
import { ReconnectRequiredError, type Fetch } from "../../connections/types";
import {
  checkTikTokOptions,
  readCreatorChoices,
  tiktokOptionsFor,
  tiktokPostInfo,
} from "../tiktok-options";
import { PENDING_LIMIT_MS, fetchOwnMedia, type NetworkSender, type TargetResult } from "./types";

export type TikTokSendDeps = {
  /** The login's access token, through `getLoginToken`. */
  accessToken(tenantId: string, loginId: string): Promise<string>;
  client?(accessToken: string): TikTokClient;
  audited(): boolean;
  fetchImpl?: Fetch;
  sleep?(ms: number): Promise<void>;
  now?(): number;
  /** How many times to ask about a video just sent before leaving it to the next round. */
  checks?: number;
};

/** Reasons TikTok gives for a post it couldn't use that trying again won't change. */
const CONTENT_PROBLEMS = /format|duration|frame_rate|picture_size|resolution|size_check|codec/i;

/** TikTok's refusal in plain words, and whether trying again might help. */
export function tiktokTrouble(err: unknown): { error: string; retry: boolean } {
  if (err instanceof ReconnectRequiredError) {
    return {
      error: "This TikTok account needs connecting again under Settings → Social accounts",
      retry: false,
    };
  }
  if (!(err instanceof TikTokError)) {
    return { error: "Something went wrong on our side. We'll try again shortly", retry: true };
  }
  if (err.isAuthError) {
    return {
      error:
        "TikTok no longer accepts this account's access. Connect it again under Settings → Social accounts",
      retry: false,
    };
  }
  switch (err.code) {
    case "unaudited_client_can_only_post_to_private_accounts":
      return {
        error:
          "TikTok only lets our app post videos that only you can see until TikTok has reviewed it. Open the post, choose “Only you” and try again",
        retry: false,
      };
    case "spam_risk_too_many_posts":
      return {
        error:
          "TikTok says this account has posted as much as it can for today. Try again tomorrow",
        retry: false,
      };
    case "spam_risk_user_banned_from_posting":
      return { error: "TikTok isn't letting this account post right now", retry: false };
    case "privacy_level_option_mismatch":
      return {
        error:
          "TikTok doesn't offer that choice of who can see it for this account any more. Open the post and choose again",
        retry: false,
      };
    case "rate_limit_exceeded":
      return { error: "TikTok is busy. We'll try again shortly", retry: true };
  }
  const said = err.words ? `: ${err.words}` : "";
  return {
    error: `TikTok wouldn't take it${said}`,
    retry: err.status === 0 || err.status === 429 || err.status >= 500,
  };
}

/**
 * Sends a post to one TikTok account as a direct post of a video: TikTok's
 * creator info first (its own rules say so, and it says who may see it),
 * then the video as a file from our own storage. Nothing goes up until the
 * whole file has arrived, so any failure before that leaves nothing behind
 * and can be tried again. Once it has arrived the answer is "pending" and
 * TikTok is asked about it (never sent it again) until it says posted or
 * failed; one never settled is "unsure" after six hours.
 */
export function createTikTokSender(deps: TikTokSendDeps): NetworkSender {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const clientFor =
    deps.client ?? ((token: string) => createTikTokClient(token, { fetchImpl: deps.fetchImpl }));

  /** What the publish status says, as an answer (or still pending). */
  async function ask(
    client: TikTokClient,
    publishId: string,
    since: string,
  ): Promise<TargetResult> {
    try {
      const status = await client.publishStatus(publishId);
      if (status.status === "PUBLISH_COMPLETE") return { id: status.postId ?? publishId };
      if (status.status === "FAILED") {
        return {
          error: `TikTok couldn't post it${status.failReason ? ` (${status.failReason.replace(/_/g, " ")})` : ""}`,
          retry: !CONTENT_PROBLEMS.test(status.failReason),
        };
      }
      if (status.status === "SEND_TO_USER_INBOX") {
        return {
          error:
            "TikTok put the video in the account's TikTok inbox instead of posting it. Finish it in the TikTok app",
          retry: false,
        };
      }
    } catch {
      // Not knowing yet is no answer: keep asking.
    }
    if (now() - Date.parse(since) > PENDING_LIMIT_MS) {
      return {
        unsure:
          "TikTok hasn't said whether it posted this. Look on TikTok, then tell us whether it's there",
      };
    }
    return { pending: publishId, since };
  }

  return async (job) => {
    const loginId = job.account.login_id;
    if (!loginId) return { error: "This TikTok account needs connecting again", retry: false };
    let client: TikTokClient;
    try {
      client = clientFor(await deps.accessToken(job.tenantId, loginId));
    } catch (err) {
      return tiktokTrouble(err);
    }

    // An earlier round left it with TikTok: only ask.
    const pending = typeof job.previous?.pending === "string" ? job.previous.pending : null;
    if (pending) {
      const since =
        typeof job.previous?.since === "string"
          ? job.previous.since
          : new Date(now()).toISOString();
      return ask(client, pending, since);
    }

    if (!job.video) return { error: "TikTok needs a video", retry: false };
    const options = tiktokOptionsFor({ [job.account.id]: job.options }, job.account.id);
    let creator;
    try {
      creator = readCreatorChoices(await client.creatorInfo());
    } catch (err) {
      return tiktokTrouble(err);
    }
    const problem = checkTikTokOptions(options, creator, deps.audited());
    if (problem) return { error: problem.replace(/\.$/, ""), retry: false };

    let video: Uint8Array;
    try {
      video = await fetchOwnMedia(job.video.url, deps.fetchImpl);
    } catch {
      return { error: "We couldn't read the video from your assets just now", retry: true };
    }
    if (!(await job.begin())) return null;
    let started: { publishId: string; uploadUrl: string };
    try {
      started = await client.initVideo(
        tiktokPostInfo(options, creator, job.words),
        video.byteLength,
      );
    } catch (err) {
      // Nothing is posted without the file, so even an unclear answer leaves nothing behind.
      return tiktokTrouble(err);
    }
    const since = new Date(now()).toISOString();
    try {
      await client.uploadVideo(started.uploadUrl, video, job.video.mimeType);
    } catch (err) {
      if (err instanceof TikTokError && err.applied === "unknown") {
        // The last of it may have arrived: TikTok's status will say.
        return { pending: started.publishId, since };
      }
      return tiktokTrouble(err);
    }
    let answer: TargetResult = { pending: started.publishId, since };
    for (let check = 0; check < (deps.checks ?? 6); check++) {
      await sleep(5_000);
      answer = await ask(client, started.publishId, since);
      if (!("pending" in answer)) break;
    }
    return answer;
  };
}
