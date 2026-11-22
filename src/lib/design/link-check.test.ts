import { describe, expect, it, vi } from "vitest";
import {
  MAX_URLS,
  PRIVATE_V4,
  checkLink,
  checkUrl,
  isPrivateAddress,
  isPrivateIpv4,
  isPrivateIpv6,
  localStatus,
  mapLimit,
  parseIpv4,
  parseIpv6,
  readRequest,
  type CheckDeps,
} from "./link-check";

const ip = (text: string) => parseIpv4(text)!;
const blocked = (url: string) => {
  const r = checkUrl(url);
  return "status" in r ? r.status : "ok";
};

describe("reading an IPv4 address however it is written", () => {
  it("reads dotted, single-number, hex, octal and short forms as the same address", () => {
    const loopback = 127 * 2 ** 24 + 1;
    for (const form of [
      "127.0.0.1",
      "2130706433",
      "0x7f000001",
      "0x7f.0.0.1",
      "0x7f.1",
      "0177.0.0.1",
      "017700000001",
      "127.1",
      "127.0.1",
      "0X7F.0x0.0.0x1",
    ])
      expect(parseIpv4(form), form).toBe(loopback);
    expect(parseIpv4("10.0.0.1")).toBe(10 * 2 ** 24 + 1);
    expect(parseIpv4("0")).toBe(0);
    expect(parseIpv4("255.255.255.255")).toBe(2 ** 32 - 1);
    expect(parseIpv4("169.254.169.254")).toBe(parseIpv4("0xa9fea9fe"));
    expect(parseIpv4("169.254.169.254")).toBe(parseIpv4("2852039166"));
  });
  it("does not take a name, or a number that is out of range, for an address", () => {
    for (const not of [
      "example.com",
      "",
      "1.2.3.4.5",
      "256.1.1.1",
      "1.2.3.256",
      "1..2",
      "4294967296",
      "1.2.3.",
      "09.1.1.1",
      "1e3",
      "-1",
      "1.2.3.4a",
      "a.b.c.d",
    ])
      expect(parseIpv4(not), not).toBeNull();
  });
});

describe("the private IPv4 ranges", () => {
  // Each range: its first and last address are private, and the addresses just outside it are judged on their own.
  const size = (bits: number) => 2 ** (32 - bits);
  it.each(PRIVATE_V4)("%s/%i (%s) is private from its first address to its last", (first, bits) => {
    const start = ip(first);
    expect(isPrivateIpv4(start)).toBe(true);
    expect(isPrivateIpv4(start + size(bits) - 1)).toBe(true);
    expect(isPrivateIpv4(start + Math.floor(size(bits) / 2))).toBe(true);
  });
  it("covers the named dangers", () => {
    const priv = [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.0.1",
      "192.168.255.255",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
    ];
    for (const a of priv) expect(isPrivateIpv4(ip(a)), a).toBe(true);
  });
  it("leaves the public internet alone, right up to the edges of each range", () => {
    const pub = [
      "1.1.1.1",
      "8.8.8.8",
      "9.255.255.255",
      "11.0.0.0",
      "100.63.255.255",
      "100.128.0.0",
      "126.255.255.255",
      "128.0.0.0",
      "169.253.255.255",
      "169.255.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "191.255.255.255",
      "192.0.1.0",
      "192.0.3.0",
      "192.88.98.255",
      "192.88.100.0",
      "192.167.255.255",
      "192.169.0.0",
      "198.17.255.255",
      "198.20.0.0",
      "198.51.99.255",
      "198.51.101.0",
      "203.0.112.255",
      "203.0.114.0",
      "223.255.255.255",
      "93.184.216.34",
    ];
    for (const a of pub) expect(isPrivateIpv4(ip(a)), a).toBe(false);
  });
});

describe("IPv6 addresses", () => {
  it("are read in full, shortened and with an IPv4 tail", () => {
    expect(parseIpv6("::1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("[::1]")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::")).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIpv6("2001:db8::8a2e:370:7334")).toEqual([
      0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334,
    ]);
    expect(parseIpv6("0:0:0:0:0:0:0:1")).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(parseIpv6("::ffff:10.0.0.1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIpv6("::FFFF:A00:1")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0a00, 0x0001]);
    expect(parseIpv6("fe80::1%eth0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    for (const not of [
      "",
      "1.2.3.4",
      "example.com",
      ":::",
      "1::2::3",
      "12345::",
      "g::1",
      "1:2:3:4:5:6:7",
      "1:2:3:4:5:6:7:8:9",
      "::ffff:999.0.0.1",
      "::ffff:1.2.3",
    ])
      expect(parseIpv6(not), not).toBeNull();
  });
  it("that are private, local or carry a private IPv4 address are refused", () => {
    const priv = [
      "::",
      "::1",
      "::ffff:127.0.0.1",
      "::ffff:10.0.0.1",
      "::ffff:169.254.169.254",
      "::ffff:7f00:1",
      "::ffff:c0a8:101",
      "::10.0.0.1",
      "::ffff:0:10.0.0.1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::7f00:1",
      "64:ff9b:1::1",
      "2002:0a00:0001::1",
      "2002:7f00:1::",
      "2002:c0a8:0101::",
      "2001::1",
      "2001:0:4136:e378:8000:63bf:3fff:fdd2",
      "2001:db8::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fe80::1",
      "febf::1",
      "fec0::1",
      "ff02::1",
      "ff00::",
      "0:0:0:0:0:ffff:a9fe:a9fe",
    ];
    for (const a of priv) expect(isPrivateIpv6(parseIpv6(a)!), a).toBe(true);
  });
  it("that are public are allowed, including ones carrying a public IPv4 address", () => {
    const pub = [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "2a00:1450:4001:81b::200e",
      "::ffff:8.8.8.8",
      "::ffff:808:808",
      "64:ff9b::8.8.8.8",
      "2002:0808:0808::1",
      "2001:1::1",
      "fbff::1",
      "fe7f::1",
    ];
    for (const a of pub) expect(isPrivateIpv6(parseIpv6(a)!), a).toBe(false);
  });
  it("answers from a name lookup are judged, and anything unreadable counts as private", () => {
    for (const a of [
      "10.0.0.7",
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "::ffff:192.168.1.1",
      "",
      "not an address",
      "0x7f.1",
      "1.2.3",
      "999.1.1.1",
    ])
      expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ["93.184.216.34", "8.8.8.8", " 1.1.1.1 ", "2606:4700:4700::1111"])
      expect(isPrivateAddress(a), a).toBe(false);
  });
});

describe("which addresses may be fetched", () => {
  it("allows ordinary public web addresses", () => {
    for (const url of [
      "https://example.com/",
      "http://example.com",
      "https://www.tufttheworld.com/collections/yarn?sort=new#top",
      "https://sub.domain.co.uk/a/b",
      "https://8.8.8.8/",
      "https://[2606:4700:4700::1111]/",
      "https://example.com:443/",
      "http://example.com:80/",
      "https://xn--bcher-kva.example.org/",
      "https://EXAMPLE.com./",
    ]) {
      expect(blocked(url), url).toBe("ok");
    }
  });
  it("refuses private and local addresses in every form they can be written", () => {
    const urls = [
      "http://127.0.0.1/",
      "http://127.1/",
      "http://2130706433/",
      "http://0x7f000001/",
      "http://0x7f.0.0.1/",
      "http://0177.0.0.1/",
      "http://017700000001/",
      "http://0/",
      "http://0.0.0.0/",
      "http://10.0.0.1/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://0xa9fea9fe/",
      "http://2852039166/",
      "http://0251.0376.0251.0376/",
      "http://[::1]/",
      "http://[::]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[::ffff:7f00:1]/",
      "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
      "http://[64:ff9b::10.0.0.1]/",
      "http://[2002:7f00:1::]/",
      "https://localhost/",
      "https://LOCALHOST/",
      "https://localhost./",
      "https://app.localhost/",
      "https://printer.local/",
      "https://db.internal/",
      "https://metadata.google.internal/",
      "https://router.lan/",
      "https://nas.home/",
      "https://intranet/",
      "https://printer/",
      "https://server.corp/",
      "https://thing.test/",
    ];
    for (const url of urls) expect(blocked(url), url).toBe("blocked");
  });
  it("refuses unusual ports, sign-in details, other schemes, and things that are not addresses", () => {
    for (const url of [
      "https://example.com:8443/",
      "http://example.com:8080/",
      "https://example.com:22/",
      "http://example.com:443/",
      "https://example.com:80/",
    ])
      expect(blocked(url), url).toBe("blocked");
    for (const url of [
      "https://user:pass@example.com/",
      "https://admin@example.com/",
      "https://example.com@127.0.0.1/",
    ])
      expect(blocked(url), url).toBe("unsafe");
    for (const url of [
      "ftp://example.com/",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,x",
      "gopher://example.com/",
      "mailto:a@b.co",
      "tel:+15551234",
    ])
      expect(blocked(url), url).toBe("cant-check");
    for (const url of [
      "not a url",
      "//example.com",
      "/relative",
      "https://",
      "https://exa mple.com/",
      "https://under_score.example.com/",
      "https://1.2.3.4.5/",
    ])
      expect(blocked(url), url).toBe("broken");
    for (const url of ["", "   ", null, undefined, 5, {}])
      expect(blocked(url as string)).toBe("empty");
    expect(blocked(`https://example.com/${"a".repeat(2000)}`)).toBe("unsafe");
  });
});

/** A pretend internet: which addresses names lead to, and how each address answers. */
function net(
  sites: Record<string, { status: number; location?: string; head?: number }>,
  names: Record<string, string[]> = {},
): CheckDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    resolve: async (host) => names[host] ?? ["93.184.216.34"],
    fetch: async (url, init) => {
      fetched.push(`${init.method} ${url}`);
      expect(init.redirect).toBe("manual");
      const site = sites[url];
      if (!site) throw new Error("connection refused");
      const status = init.method === "HEAD" && site.head ? site.head : site.status;
      return {
        status,
        headers: {
          get: (name: string) =>
            name.toLowerCase() === "location" ? (site.location ?? null) : null,
        },
        body: null,
      };
    },
  };
}

describe("checking a link", () => {
  it("says a page that answers is working, and one that does not is broken", async () => {
    const world = net({
      "https://example.com/": { status: 200 },
      "https://example.com/gone": { status: 404 },
      "https://example.com/error": { status: 500 },
      "https://example.com/made": { status: 204 },
    });
    expect(await checkLink("https://example.com/", world)).toEqual({
      url: "https://example.com/",
      status: "ok",
      code: 200,
    });
    expect(await checkLink("https://example.com/made", world)).toMatchObject({
      status: "ok",
      code: 204,
    });
    expect(await checkLink("https://example.com/gone", world)).toMatchObject({
      status: "broken",
      code: 404,
      reason: "The page was not found.",
    });
    expect(await checkLink("https://example.com/error", world)).toMatchObject({
      status: "broken",
      code: 500,
    });
    expect(await checkLink("https://example.com/unplugged", world)).toMatchObject({
      status: "broken",
      reason: "The site did not answer.",
    });
    expect(world.fetched.every((f) => f.startsWith("HEAD "))).toBe(true);
  });
  it("asks again with GET where a site refuses HEAD", async () => {
    for (const head of [405, 403, 501]) {
      const world = net({ "https://example.com/": { status: 200, head } });
      expect(await checkLink("https://example.com/", world)).toMatchObject({
        status: "ok",
        code: 200,
      });
      expect(world.fetched).toEqual(["HEAD https://example.com/", "GET https://example.com/"]);
    }
    const stillNo = net({ "https://example.com/": { status: 403, head: 403 } });
    expect(await checkLink("https://example.com/", stillNo)).toMatchObject({
      status: "broken",
      code: 403,
    });
  });
  it("follows redirects, by hand, and says where it ended up", async () => {
    const world = net({
      "https://example.com/a": { status: 301, location: "/b" },
      "https://example.com/b": { status: 302, location: "https://www.example.org/c" },
      "https://www.example.org/c": { status: 200 },
    });
    expect(await checkLink("https://example.com/a", world)).toEqual({
      url: "https://example.com/a",
      status: "redirect",
      code: 200,
      finalUrl: "https://www.example.org/c",
    });
    expect(world.fetched).toEqual([
      "HEAD https://example.com/a",
      "HEAD https://example.com/b",
      "HEAD https://www.example.org/c",
    ]);
    const ends = net({
      "https://example.com/a": { status: 301, location: "https://example.com/gone" },
      "https://example.com/gone": { status: 404 },
    });
    expect(await checkLink("https://example.com/a", ends)).toMatchObject({
      status: "broken",
      code: 404,
      finalUrl: "https://example.com/gone",
    });
  });
  it("gives up after five redirects", async () => {
    const sites: Record<string, { status: number; location: string }> = {};
    for (let i = 0; i < 10; i++)
      sites[`https://example.com/${i}`] = { status: 302, location: `/${i + 1}` };
    const world = net(sites);
    expect(await checkLink("https://example.com/0", world)).toMatchObject({
      status: "broken",
      reason: "It redirects too many times.",
    });
    expect(world.fetched).toHaveLength(6);
    const loop = net({ "https://example.com/x": { status: 302, location: "/x" } });
    expect(await checkLink("https://example.com/x", loop)).toMatchObject({
      status: "broken",
      reason: "It redirects too many times.",
    });
  });
  it("never fetches a private address: not directly, not by name, not by redirect", async () => {
    const world = net(
      {
        "https://example.com/inward": {
          status: 302,
          location: "http://169.254.169.254/latest/meta-data/",
        },
        "https://example.com/local": { status: 301, location: "http://localhost/admin" },
        "https://example.com/mapped": { status: 301, location: "http://[::ffff:10.0.0.1]/" },
        "https://example.com/decimal": { status: 301, location: "http://2130706433/" },
        "https://example.com/port": { status: 301, location: "https://example.org:8443/" },
        "https://example.com/file": { status: 301, location: "file:///etc/passwd" },
        "https://example.com/rebind": { status: 301, location: "https://rebind.example.net/" },
        "http://127.0.0.1/": { status: 200 },
        "http://169.254.169.254/latest/meta-data/": { status: 200 },
        "http://localhost/admin": { status: 200 },
        "https://intranet.example.com/": { status: 200 },
        "https://rebind.example.net/": { status: 200 },
        "https://six.example.com/": { status: 200 },
        "https://mixed.example.com/": { status: 200 },
      },
      {
        "intranet.example.com": ["10.0.0.7"],
        "rebind.example.net": ["192.168.1.1"],
        "six.example.com": ["fd00::1"],
        "mixed.example.com": ["93.184.216.34", "127.0.0.1"],
        "nowhere.example.com": [],
      },
    );
    for (const url of [
      "http://127.0.0.1/",
      "https://intranet.example.com/",
      "https://six.example.com/",
      "https://mixed.example.com/",
    ])
      expect(await checkLink(url, world), url).toMatchObject({ status: "blocked" });
    for (const path of ["inward", "local", "mapped", "decimal", "port", "rebind"])
      expect(await checkLink(`https://example.com/${path}`, world), path).toMatchObject({
        status: "blocked",
      });
    expect(await checkLink("https://example.com/file", world)).toMatchObject({ status: "broken" });
    expect(await checkLink("https://nowhere.example.com/", world)).toMatchObject({
      status: "broken",
      reason: "No site was found at this address.",
    });
    // Only the public hops were ever asked for.
    expect(world.fetched.every((f) => /^HEAD https:\/\/example\.com\//.test(f))).toBe(true);
    expect(world.fetched).toHaveLength(7);
  });
  it("stops waiting after the time allowed", async () => {
    vi.useFakeTimers();
    const slow: CheckDeps = {
      resolve: async () => ["93.184.216.34"],
      fetch: (_url, init) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
      timeoutMs: 8000,
    };
    const pending = checkLink("https://example.com/slow", slow);
    await vi.advanceTimersByTimeAsync(8100);
    expect(await pending).toMatchObject({
      status: "broken",
      reason: "It took too long to answer.",
    });
    vi.useRealTimers();
  });
  it("lets go of anything a site starts to send, and returns only a status", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const world: CheckDeps = {
      resolve: async () => ["93.184.216.34"],
      fetch: async () => ({ status: 200, headers: { get: () => null }, body: { cancel } }),
    };
    const result = await checkLink("https://example.com/", world);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(Object.keys(result).sort()).toEqual(["code", "status", "url"]);
  });
});

describe("the request and its limits", () => {
  it("takes a list of at most fifty addresses of at most 2000 characters", () => {
    expect(readRequest({ urls: ["https://example.com/"] })).toEqual({
      urls: ["https://example.com/"],
    });
    expect(readRequest({ urls: [] })).toEqual({ urls: [] });
    expect(readRequest({ urls: Array.from({ length: MAX_URLS }, () => "x") })).toHaveProperty(
      "urls",
    );
    expect(readRequest({ urls: Array.from({ length: MAX_URLS + 1 }, () => "x") })).toHaveProperty(
      "error",
    );
    expect(readRequest({ urls: ["a".repeat(2000)] })).toHaveProperty("urls");
    expect(readRequest({ urls: ["a".repeat(2001)] })).toHaveProperty("error");
    for (const bad of [
      null,
      undefined,
      {},
      { urls: "https://example.com" },
      { urls: [5] },
      { urls: [null] },
      "text",
      7,
    ])
      expect(readRequest(bad), JSON.stringify(bad)).toHaveProperty("error");
  });
  it("runs only so many checks at once, and keeps the answers in order", async () => {
    let running = 0;
    let most = 0;
    const out = await mapLimit(
      Array.from({ length: 20 }, (_, i) => i),
      6,
      async (i) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((r) => setTimeout(r, (20 - i) % 5));
        running -= 1;
        return i * 2;
      },
    );
    expect(out).toEqual(Array.from({ length: 20 }, (_, i) => i * 2));
    expect(most).toBe(6);
    expect(await mapLimit([], 6, async (x) => x)).toEqual([]);
  });
});

describe("what can be told from a link without fetching it", () => {
  it("names the links that need no fetching, and why", () => {
    const status = (url: string) => localStatus(url)?.status ?? null;
    expect(status("")).toBe("empty");
    expect(status("   ")).toBe("empty");
    for (const url of [
      "PASTE-YOUR-UNSUBSCRIBE-LINK-HERE",
      "https://",
      "http://",
      "https://example.com",
      "https://www.example.com/page",
      "#",
      "your link here",
    ])
      expect(status(url), url).toBe("placeholder");
    for (const url of [
      "{{ unsubscribe_link }}",
      "{{unsubscribe_link}}",
      "{{ shop.url }}",
      "mailto:hello@tufttheworld.com",
      "MAILTO:a@b.co",
      "tel:+15551234567",
    ])
      expect(status(url), url).toBe("cant-check");
    for (const url of ["http://tufttheworld.com/", "HTTP://tufttheworld.com"])
      expect(status(url), url).toBe("not-https");
    for (const url of [
      "javascript:alert(1)",
      "ftp://x.example.org",
      "tufttheworld.com",
      "/relative",
      "data:text/html,x",
    ])
      expect(status(url), url).toBe("unsafe");
    for (const url of ["https://localhost/", "https://192.168.1.1/", "https://shop.local/"])
      expect(status(url), url).toBe("blocked");
    expect(status("https://tufttheworld.com:8443/")).toBe("blocked");
    for (const url of [
      "https://tufttheworld.com/",
      "https://tufttheworld.com/collections/yarn?a=1&b=2",
      " https://tufttheworld.com/ ",
    ])
      expect(localStatus(url), url).toBeNull();
  });
});
