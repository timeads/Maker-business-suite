import type { Fetch } from "../../connections/types";
import type { PostAccount } from "../targets";

/**
 * What one target's try came to, as kept in the post's `results`:
 *   {id}                posted;
 *   {error, retry?}     not posted; `retry: false` when trying again can't
 *                       help (it is then marked `stop` until a person
 *                       presses "Try again");
 *   {pending, since}    the network has it and is still preparing it: it is
 *                       asked about again, never sent again;
 *   {unsure}            we never heard back: never sent again by itself.
 */
export type TargetResult =
  | { id: string }
  | { error: string; retry?: boolean }
  | { pending: string; since: string }
  | { unsure: string };

export type SendJob = {
  tenantId: string;
  account: PostAccount;
  /** The words for this account (its own, or the post's). */
  words: string;
  photos: { url: string; mimeType: string }[];
  video: { url: string; mimeType: string } | null;
  /** This account's own choices on the post (`target_options[account id]`), not yet checked. */
  options: unknown;
  /** What an earlier try left: a `pending` answer to ask about again. */
  previous: Record<string, unknown> | null;
  /**
   * Marks the one write that publishes, just before it is made. False: it
   * mustn't be made (already marked, or the post isn't out with us): send
   * nothing and report nothing.
   */
  begin(): Promise<boolean>;
};

/** Sends one account's part of a post, or asks again about one being prepared. Null: nothing to report. */
export type NetworkSender = (job: SendJob) => Promise<TargetResult | null>;

/** Longest the worker keeps asking about a post being prepared before saying it can't tell. */
export const PENDING_LIMIT_MS = 6 * 60 * 60 * 1000;

/** Biggest file the worker fetches from our own storage to pass on (the uploads are capped lower). */
const MAX_MEDIA_BYTES = 256 * 1024 * 1024;

/**
 * Fetches one of the workspace's own photos or videos from our public
 * `social` bucket, to hand to a network that takes the file itself. Nothing
 * else is ever fetched: the address must be our bucket's.
 */
export async function fetchOwnMedia(url: string, fetchImpl: Fetch = fetch): Promise<Uint8Array> {
  const base = `${(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/+$/, "")}/storage/v1/object/public/social/`;
  if (!base.startsWith("https://") && !base.startsWith("http://")) {
    throw new Error("Our storage address isn't set");
  }
  if (!url.startsWith(base) || url.includes("..")) throw new Error("Not one of our own files");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Our storage answered ${response.status}`);
  const size = Number(response.headers.get("content-length") ?? 0);
  if (size > MAX_MEDIA_BYTES) throw new Error("That file is too big to send");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_MEDIA_BYTES) throw new Error("That file is too big to send");
  return bytes;
}
