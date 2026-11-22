// Checking the links in an email before it is sent: which addresses may be fetched at all, how a
// fetch is followed and judged, and what can be said about a link without fetching it.
//
// The checker runs on the hub's server and fetches addresses the owner typed, so the first job
// here is refusing any address that points back inside a private network (the server's own
// machine, its cloud provider's metadata service, a home router). Every address is checked
// before it is fetched, again after its name is looked up, and again at every redirect.
//
// Pure: the network is passed in, so all of this is tested without one.

export const MAX_URLS = 50;
export const MAX_URL_LENGTH = 2000;
export const MAX_HOPS = 5;
export const TIMEOUT_MS = 8000;

/**
 * What can be said about a link.
 * ok: it answers. redirect: it answers after sending the reader on elsewhere. broken: it does
 * not answer, or answers with an error. empty: no address. placeholder: a stand-in that was
 * never replaced. not-https: an http: address. cant-check: nothing to fetch (an email address,
 * a phone number, a tag the sending platform fills in). blocked: an address readers cannot
 * reach (a private network). unsafe: not a kind of address an email may link to.
 */
export type LinkStatus =
  | "ok"
  | "redirect"
  | "broken"
  | "empty"
  | "placeholder"
  | "not-https"
  | "cant-check"
  | "blocked"
  | "unsafe";

export interface LinkResult {
  url: string;
  status: LinkStatus;
  code?: number;
  finalUrl?: string;
  reason?: string;
}

/* ---------- Addresses that must never be fetched ---------- */

/** One part of an IPv4 address as old network code reads it: decimal, hex (0x1f) or octal (017). */
function partOf(text: string): number | null {
  if (/^0x[0-9a-f]*$/i.test(text)) return text.length === 2 ? 0 : parseInt(text.slice(2), 16);
  if (/^0[0-7]*$/.test(text)) return parseInt(text, 8) || 0;
  if (/^[1-9][0-9]*$/.test(text)) return parseInt(text, 10);
  return null;
}

/**
 * An IPv4 address as a number, in any form a browser or operating system accepts: 127.0.0.1,
 * but also 2130706433, 0x7f.1, 0177.0.0.1 and 127.1. Null when the text is not an address.
 */
export function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4 || parts.some((p) => p === "")) return null;
  const nums = parts.map(partOf);
  if (nums.some((n) => n === null || !Number.isFinite(n))) return null;
  const n = nums as number[];
  // The last part fills whatever bytes the parts before it leave: 127.1 is 127.0.0.1.
  const last = n[n.length - 1];
  if (n.slice(0, -1).some((x) => x > 255) || last >= 256 ** (5 - n.length)) return null;
  return n.slice(0, -1).reduce((sum, x, i) => sum + x * 256 ** (3 - i), 0) + last;
}

/** Ranges of IPv4 that are not the public internet: [first address, bits fixed, what it is]. */
export const PRIVATE_V4: [string, number, string][] = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "carrier NAT"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local, cloud metadata"],
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "protocol assignments"],
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved, broadcast"],
];
const V4_RANGES = PRIVATE_V4.map(([first, bits]) => [parseIpv4(first)!, bits] as const);

export function isPrivateIpv4(n: number): boolean {
  return V4_RANGES.some(
    ([first, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(first / 2 ** (32 - bits)),
  );
}

/** An IPv6 address as its eight 16-bit groups, or null. Takes "::" and an IPv4 tail (::ffff:10.0.0.1). */
export function parseIpv6(text: string): number[] | null {
  let s = text.trim().toLowerCase();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  // A zone (fe80::1%eth0) names a network card, never part of the address.
  s = s.split("%")[0];
  if (!s.includes(":") || !/^[0-9a-f:.]+$/.test(s)) return null;
  const tail = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(tail[2]) ? tail[2].split(".").map(Number) : null;
    if (!v4 || v4.some((x) => x > 255)) return null;
    s = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string) => (part === "" ? [] : part.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [
    ...head,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...rest,
  ];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return all.map((g) => parseInt(g, 16));
}

export function isPrivateIpv6(g: number[]): boolean {
  const v4 = g[6] * 65536 + g[7];
  const zeros = (count: number) => g.slice(0, count).every((x) => x === 0);
  // An IPv4 address written inside an IPv6 one is judged as the IPv4 address it is.
  if (zeros(5) && g[5] === 0xffff) return isPrivateIpv4(v4); // ::ffff:a.b.c.d, IPv4-mapped
  if (zeros(6)) return true; // ::, ::1 and the old "IPv4-compatible" form
  if (zeros(4) && g[4] === 0xffff && g[5] === 0) return isPrivateIpv4(v4); // ::ffff:0:a.b.c.d, translated
  if (g[0] === 0x64 && g[1] === 0xff9b)
    return g[2] !== 0 || g[3] !== 0 || g[4] !== 0 || g[5] !== 0 || isPrivateIpv4(v4); // NAT64, and its local-use block
  if (g[0] === 0x2002) return isPrivateIpv4(g[1] * 65536 + g[2]); // 6to4 carries an IPv4 address
  if (g[0] === 0x2001 && g[1] === 0) return true; // Teredo tunnelling
  if (g[0] === 0x2001 && g[1] === 0xdb8) return true; // documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7, unique local
  if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10, old site-local
  if ((g[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

/** Whether an address a name resolved to is off the public internet. Anything that is not an address counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const v6 = parseIpv6(ip);
  if (v6) return isPrivateIpv6(v6);
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(ip.trim()) ? parseIpv4(ip.trim()) : null;
  return v4 === null ? true : isPrivateIpv4(v4);
}

export type UrlCheck = { ok: true; url: URL } | { ok: false; status: LinkStatus; reason: string };

/**
 * Whether an address may be fetched by the checker, judged from its text alone. Only http: and
 * https: on their usual ports, with no sign-in details, to a host that is a public name or a
 * public IP address.
 */
export function checkUrl(raw: unknown): UrlCheck {
  const no = (status: LinkStatus, reason: string): UrlCheck => ({ ok: false, status, reason });
  if (typeof raw !== "string" || raw.trim() === "") return no("empty", "No address.");
  if (raw.length > MAX_URL_LENGTH) return no("unsafe", "The address is too long.");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return no("broken", "This is not a web address.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    return no("cant-check", "Only web addresses can be checked.");
  if (url.username || url.password) return no("unsafe", "The address has sign-in details in it.");
  if (url.port !== "") return no("blocked", "The address uses an unusual port.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[")) {
    const v6 = parseIpv6(host);
    return !v6 || isPrivateIpv6(v6)
      ? no("blocked", "The address is on a private network.")
      : { ok: true, url };
  }
  // A host made only of numbers is an IP address however it is written (2130706433, 0x7f.1).
  const v4 = parseIpv4(host);
  if (v4 !== null)
    return isPrivateIpv4(v4)
      ? no("blocked", "The address is on a private network.")
      : { ok: true, url };
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host))
    return no("broken", "This is not a web address.");
  const labels = host.split(".");
  const last = labels[labels.length - 1];
  if (
    labels.length < 2 ||
    /^\d+$/.test(last) ||
    [
      "localhost",
      "local",
      "internal",
      "localdomain",
      "lan",
      "home",
      "intranet",
      "corp",
      "test",
      "invalid",
      "example",
      "onion",
    ].includes(last)
  ) {
    return no("blocked", "The address is on a private network.");
  }
  return { ok: true, url };
}

/* ---------- Fetching and judging ---------- */

export interface CheckDeps {
  /** Every address (IPv4 and IPv6) a host name leads to. */
  resolve: (host: string) => Promise<string[]>;
  /** Fetch without following redirects. Only the status and the Location header are read. */
  fetch: (
    url: string,
    init: {
      method: "HEAD" | "GET";
      redirect: "manual";
      signal: AbortSignal;
      headers: Record<string, string>;
    },
  ) => Promise<{
    status: number;
    headers: { get(name: string): string | null };
    body?: { cancel(): Promise<void> } | null;
  }>;
  timeoutMs?: number;
}

const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; link-check)", Accept: "*/*" };

/** Fetch one address, with HEAD first and GET where the site refuses HEAD. The body is never read. */
async function ask(
  url: string,
  deps: CheckDeps,
  signal: AbortSignal,
): Promise<{ status: number; location: string | null }> {
  for (const method of ["HEAD", "GET"] as const) {
    const res = await deps.fetch(url, { method, redirect: "manual", signal, headers: HEADERS });
    // Let go of whatever the site started to send; only its answer matters.
    await res.body?.cancel().catch(() => undefined);
    if (method === "HEAD" && (res.status === 405 || res.status === 403 || res.status === 501))
      continue;
    return { status: res.status, location: res.headers.get("location") };
  }
  return { status: 0, location: null };
}

/**
 * Check one link: follow it, at most five redirects deep, and say whether it answers. Each
 * address on the way is checked before it is fetched, by its text and by where its name leads,
 * so a public address that redirects into a private network is stopped there.
 */
export async function checkLink(raw: string, deps: CheckDeps): Promise<LinkResult> {
  const first = checkUrl(raw);
  if ("status" in first) return { url: raw, status: first.status, reason: first.reason };
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), deps.timeoutMs ?? TIMEOUT_MS);
  try {
    let url = first.url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const host = url.hostname.toLowerCase().replace(/\.$/, "");
      // A name is looked up and every answer judged. An IP address needs no looking up and was judged by its text.
      if (!host.startsWith("[") && parseIpv4(host) === null) {
        const addresses = await deps.resolve(host).catch(() => [] as string[]);
        if (control.signal.aborted)
          return { url: raw, status: "broken", reason: "It took too long to answer." };
        if (addresses.length === 0)
          return { url: raw, status: "broken", reason: "No site was found at this address." };
        if (addresses.some(isPrivateAddress))
          return { url: raw, status: "blocked", reason: "The address leads to a private network." };
      }
      const { status, location } = await ask(url.href, deps, control.signal);
      if (status >= 300 && status < 400 && location) {
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          return {
            url: raw,
            status: "broken",
            code: status,
            reason: "It redirects to something that is not an address.",
          };
        }
        const allowed = checkUrl(next.href);
        if ("status" in allowed)
          return {
            url: raw,
            status:
              allowed.status === "blocked" || allowed.status === "unsafe" ? "blocked" : "broken",
            code: status,
            reason: `It redirects somewhere that cannot be followed. ${allowed.reason}`,
          };
        url = allowed.url;
        continue;
      }
      const good = status >= 200 && status < 300;
      return {
        url: raw,
        code: status,
        status: good ? (hop > 0 ? "redirect" : "ok") : "broken",
        ...(hop > 0 ? { finalUrl: url.href } : {}),
        ...(good
          ? {}
          : {
              reason:
                status === 404
                  ? "The page was not found."
                  : status === 0
                    ? "The site did not answer."
                    : `The site answered with an error (${status}).`,
            }),
      };
    }
    return { url: raw, status: "broken", reason: "It redirects too many times." };
  } catch {
    return {
      url: raw,
      status: "broken",
      reason: control.signal.aborted ? "It took too long to answer." : "The site did not answer.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run a job over a list with only so many going at once, keeping the results in order. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  job: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await job(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** The list of addresses a request asks to have checked, or what is wrong with the request. */
export function readRequest(body: unknown): { urls: string[] } | { error: string } {
  const urls = (body as { urls?: unknown } | null)?.urls;
  if (!Array.isArray(urls)) return { error: "Send the links to check as a list." };
  if (urls.length > MAX_URLS) return { error: `At most ${MAX_URLS} links can be checked at once.` };
  if (urls.some((u) => typeof u !== "string" || u.length > MAX_URL_LENGTH))
    return { error: `Each link must be text of at most ${MAX_URL_LENGTH} characters.` };
  return { urls: urls as string[] };
}

/* ---------- What can be said without fetching ---------- */

const TAG = /^\{\{\s*[a-z_][a-z0-9_.]*\s*\}\}$/i;
/** Stand-ins that were never replaced with a real address. */
const PLACEHOLDERS = [
  /^PASTE-YOUR-UNSUBSCRIBE-LINK-HERE$/,
  /^https?:\/\/?$/i,
  /^https?:\/\/(www\.)?example\.(com|org|net)(\/.*)?$/i,
  /^#+$/,
  /^(your|the)[- ]?(link|url)([- ]here)?$/i,
];

/**
 * What is known about a link from its text alone. Null means it is a secure web address, which
 * only fetching can judge.
 */
export function localStatus(raw: string): LinkResult | null {
  const url = raw.trim();
  const say = (status: LinkStatus, reason: string): LinkResult => ({ url: raw, status, reason });
  if (url === "") return say("empty", "No link yet.");
  if (TAG.test(url)) return say("cant-check", "Your sending platform fills this in when it sends.");
  if (PLACEHOLDERS.some((p) => p.test(url)))
    return say("placeholder", "A stand-in that still needs a real address.");
  if (/^mailto:/i.test(url))
    return say("cant-check", "An email address. It opens the reader's email program.");
  if (/^tel:/i.test(url)) return say("cant-check", "A phone number.");
  if (/^http:\/\//i.test(url))
    return say("not-https", "Starts with http://. Links in the email must start with https://.");
  if (!/^https:\/\//i.test(url))
    return say("unsafe", "Not a web address, so it is left out of the email.");
  const allowed = checkUrl(url);
  return "status" in allowed ? { url: raw, status: allowed.status, reason: allowed.reason } : null;
}
