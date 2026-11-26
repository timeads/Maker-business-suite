import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Twilio signs every request it sends us (header `X-Twilio-Signature`), as
 * its security documentation describes:
 *
 *   1. take the whole address Twilio was given for the webhook, query and all;
 *   2. for a form post, sort the posted fields by name and add each name and
 *      its value straight after it, with nothing between;
 *   3. HMAC-SHA1 that with the account's auth token, then base64.
 *
 * We work it out ourselves and compare in constant time. The auth token is
 * the workspace's own, read from Vault through `getTwilioAccess`; it is never
 * an environment variable and never leaves the server.
 */

/** The string Twilio signs, for a form post to `url` carrying `params`. */
export function signedString(url: string, params: URLSearchParams): string {
  const byName = new Map<string, string[]>();
  for (const [name, value] of params) {
    byName.set(name, [...(byName.get(name) ?? []), value]);
  }
  let out = url;
  for (const name of [...byName.keys()].sort()) {
    for (const value of byName.get(name)!.sort()) out += name + value;
  }
  return out;
}

export function twilioSignature(authToken: string, url: string, params: URLSearchParams): string {
  return createHmac("sha1", authToken).update(signedString(url, params), "utf8").digest("base64");
}

/**
 * The same address with and without the standard port, since what Twilio
 * signs is what it was given and a proxy may add or drop ":443".
 */
function addressForms(url: string): string[] {
  try {
    const parsed = new URL(url);
    if (!parsed.port) {
      // URL drops a default port when it is set, so build the string by hand.
      const host = `${parsed.hostname}:${parsed.protocol === "https:" ? "443" : "80"}`;
      return [url, url.replace(parsed.host, host)];
    }
    return [url];
  } catch {
    return [url];
  }
}

/** Whether `header` is Twilio's signature for this request. Constant-time. */
export function validTwilioSignature(
  authToken: string,
  url: string,
  params: URLSearchParams,
  header: string | null,
): boolean {
  if (!authToken || !header || !/^[A-Za-z0-9+/]+=*$/.test(header.trim())) return false;
  const given = Buffer.from(header.trim(), "base64");
  let ok = false;
  for (const form of addressForms(url)) {
    const expected = Buffer.from(twilioSignature(authToken, form, params), "base64");
    // Every form is compared, so the time taken never says which one matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok;
}
