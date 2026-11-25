import { MAX_FILE_BYTES, type IncomingFile } from "../files";
import type { MediaKind } from "./events";

/**
 * Fetching what a customer sent. Meta hands over a link that stops working
 * after a while, so the worker downloads the file once and keeps it under
 * the help desk's usual rules. The link came inside a signed webhook, never
 * from a person; even so it is fetched only from Meta's own file hosts, over
 * https, and a redirect is followed only to another of them.
 */
const META_FILE_HOSTS = ["fbcdn.net", "fbsbx.com", "cdninstagram.com"] as const;

/** The address as a URL when it is one of Meta's file hosts over https; otherwise null. */
export function metaFileUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || raw.length > 4000) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  // A name, never a number: an address written as an IP is not one of Meta's hosts.
  if (!/^[a-z0-9.-]+$/.test(host) || /^[0-9.]+$/.test(host)) return null;
  return META_FILE_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
    ? url
    : null;
}

export class MediaRefused extends Error {
  constructor(public reason: "host" | "too_big" | "status" | "redirects") {
    super(`media not fetched: ${reason}`);
    this.name = "MediaRefused";
  }
}

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "application/pdf": "pdf",
};
const NAMES: Record<MediaKind, string> = {
  image: "photo",
  video: "video",
  audio: "voice-message",
  file: "file",
};

/** A name of our own for a file that arrived without one. */
export function mediaName(kind: MediaKind, type: string, index: number): string {
  const ext = EXTENSIONS[type.split(";")[0].trim().toLowerCase()];
  return `${NAMES[kind]}${index > 0 ? `-${index + 1}` : ""}${ext ? `.${ext}` : ""}`;
}

/** Reads a response's body, stopping as soon as it is bigger than we keep. */
async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const stated = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(stated) && stated > max) throw new MediaRefused("too_big");
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    if (all.length > max) throw new MediaRefused("too_big");
    return all;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new MediaRefused("too_big");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * Downloads one file from Meta. No cookies, no credentials, no referrer; at
 * most three redirects, each checked against the same list of hosts.
 */
export async function fetchMetaFile(
  rawUrl: string,
  fetchImpl: typeof fetch = fetch,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<{ bytes: Uint8Array; type: string }> {
  let url = metaFileUrl(rawUrl);
  for (let hop = 0; hop < 4; hop += 1) {
    if (!url) throw new MediaRefused("host");
    const response = await fetchImpl(url.toString(), {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get("location");
      url = next ? metaFileUrl(new URL(next, url).toString()) : null;
      continue;
    }
    if (!response.ok) throw new MediaRefused("status");
    return {
      bytes: await readCapped(response, maxBytes),
      type: (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase(),
    };
  }
  throw new MediaRefused("redirects");
}

/**
 * A message's files, fetched and ready for the usual keeping rules (which
 * look at each file's own first bytes). A file that can't be fetched is
 * still listed, as one we didn't keep.
 */
export async function fetchMessageMedia(
  media: { kind: MediaKind; url: string }[],
  fetchImpl: typeof fetch = fetch,
): Promise<IncomingFile[]> {
  const files: IncomingFile[] = [];
  for (const [index, item] of media.entries()) {
    try {
      const got = await fetchMetaFile(item.url, fetchImpl);
      files.push({
        name: mediaName(item.kind, got.type, index),
        claimed: got.type,
        bytes: got.bytes,
        contentId: null,
      });
    } catch (err) {
      // Trouble on the way (a timeout, a dropped connection) is worth another try later.
      if (!(err instanceof MediaRefused)) throw err;
      // Never the link itself: it carries a signature.
      console.error(`a message's ${item.kind} wasn't fetched: ${err.reason}`);
      files.push({
        name: mediaName(item.kind, "", index),
        claimed: "",
        bytes: new Uint8Array(),
        contentId: null,
        statedSize: err.reason === "too_big" ? MAX_FILE_BYTES + 1 : 0,
        failed: true,
      });
    }
  }
  return files;
}
