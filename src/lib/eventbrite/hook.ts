import { createHash, randomBytes } from "node:crypto";

/**
 * The secret in a workspace's Eventbrite webhook address. Eventbrite doesn't
 * sign its webhooks, so the address itself is the proof, like the help
 * desk's inbound email: `<site>/api/webhooks/eventbrite/<secret>`. Only the
 * secret's hash is kept; the address goes to Eventbrite once and is never
 * shown or logged.
 */

export const HOOK_PATH = "/api/webhooks/eventbrite/";
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;

export const newHookToken = () => randomBytes(32).toString("base64url");

export const isHookToken = (value: string) => TOKEN.test(value);

export const hookTokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export const hookEndpoint = (site: string, token: string) =>
  `${site.replace(/\/+$/, "")}${HOOK_PATH}${token}`;

/** The secrets in those of Eventbrite's webhook addresses that point at this site. */
export function tokensAtSite(site: string, endpoints: string[]): string[] {
  const base = `${site.replace(/\/+$/, "")}${HOOK_PATH}`;
  return endpoints
    .filter((url) => url.startsWith(base))
    .map((url) => url.slice(base.length).split(/[/?#]/)[0])
    .filter(isHookToken);
}
