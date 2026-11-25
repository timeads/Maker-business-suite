import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Proof that a request really came from Meta. Both checks use the app
 * secret, on the bytes exactly as they arrived, and compare in constant time.
 */

/** `X-Hub-Signature-256: sha256=<hex>` over the raw body of a webhook. */
export function validMetaSignature(
  rawBody: string | Uint8Array,
  header: string | null | undefined,
  appSecret: string | undefined,
): boolean {
  if (!appSecret || typeof header !== "string") return false;
  const match = /^sha256=([0-9a-f]{64})$/i.exec(header.trim());
  if (!match) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  const given = Buffer.from(match[1], "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The answer to Meta's check of our webhook address: the challenge, only when
 * the mode is "subscribe" and the token is the one we were set up with.
 */
export function webhookChallenge(
  params: URLSearchParams,
  verifyToken: string | undefined,
): string | null {
  const token = params.get("hub.verify_token") ?? "";
  const challenge = params.get("hub.challenge");
  if (!verifyToken || params.get("hub.mode") !== "subscribe" || !challenge) return null;
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return challenge.slice(0, 200);
}

const fromBase64Url = (text: string) => Buffer.from(text, "base64url");

/**
 * Meta's "signed request" (the data deletion callback): `<signature>.<payload>`,
 * both base64url, the signature an HMAC-SHA256 of the payload text. Returns
 * the id it names, or null when anything about it is wrong.
 */
export function parseSignedRequest(
  signedRequest: unknown,
  appSecret: string | undefined,
): { userId: string } | null {
  if (!appSecret || typeof signedRequest !== "string" || signedRequest.length > 4000) return null;
  const [signature, payload, ...rest] = signedRequest.split(".");
  if (!signature || !payload || rest.length > 0) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(signature) || !/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  const expected = createHmac("sha256", appSecret).update(payload).digest();
  const given = fromBase64Url(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(fromBase64Url(payload).toString("utf8")) as {
      algorithm?: unknown;
      user_id?: unknown;
    };
    if (String(data.algorithm ?? "").toUpperCase() !== "HMAC-SHA256") return null;
    const userId = typeof data.user_id === "number" ? String(data.user_id) : data.user_id;
    return typeof userId === "string" && /^[0-9A-Za-z_-]{1,64}$/.test(userId) ? { userId } : null;
  } catch {
    return null;
  }
}
