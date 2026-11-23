import type { Fetch } from "../../connections/types";
import { sniffLabel } from "./redo";
import type { LabelFile } from "./types";

const TIMEOUT_MS = 20_000;
/** A label is small; anything bigger isn't one. */
const MAX_LABEL_BYTES = 4_000_000;

type Kept = Pick<LabelFile, "contentType" | "data">;

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/** What kind of label a base64 file really is, whatever was asked for. Null when it is none we know. */
export function labelKind(data: string): LabelFile["contentType"] | null {
  try {
    const head = atob(data.slice(0, 128));
    return sniffLabel(Uint8Array.from(head, (ch) => ch.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * Where EasyPost keeps label files. Only used when a label is fetched again
 * later from a link kept in the database: a link straight out of EasyPost's
 * own reply is trusted as it stands.
 */
export function isEasyPostFileLink(link: string): boolean {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    return (
      host === "easypost.com" ||
      host.endsWith(".easypost.com") ||
      /^easypost-files\.s3[.-][a-z0-9.-]*amazonaws\.com$/.test(host)
    );
  } catch {
    return false;
  }
}

/**
 * Fetches a bought label's file from the link EasyPost gave: no key is sent,
 * the link is the whole secret. Null when the file can't be had or isn't a
 * label; the label is still bought, and EasyPost still has it.
 */
export async function downloadEasyPostLabel(
  link: string,
  fetchImpl: Fetch = fetch,
  timeoutMs = TIMEOUT_MS,
): Promise<Kept | null> {
  try {
    const url = new URL(link);
    if (url.protocol !== "https:") return null;
    const response = await fetchImpl(url.toString(), {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_LABEL_BYTES) return null;
    const contentType = sniffLabel(bytes);
    return contentType ? { contentType, data: toBase64(bytes) } : null;
  } catch {
    return null;
  }
}
