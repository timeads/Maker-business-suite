import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { memoryStore } from "../testing";
import { ConnectError, ReconnectRequiredError, type Fetch } from "../types";
import { createQuickBooksAdapter } from "./quickbooks";
import {
  createShopifyAdapter,
  normalizeShopDomain,
  verifyShopifyQueryHmac,
  verifyShopifyWebhookHmac,
} from "./shopify";

// Generated per run: nothing here is a real credential.
const shopifySecret = randomBytes(16).toString("hex");
const intuitSecret = randomBytes(16).toString("hex");

beforeAll(() => {
  process.env.SHOPIFY_CLIENT_ID = "shopify-client";
  process.env.SHOPIFY_CLIENT_SECRET = shopifySecret;
  process.env.QUICKBOOKS_CLIENT_ID = "intuit-client";
  process.env.QUICKBOOKS_CLIENT_SECRET = intuitSecret;
});

type Call = { url: string; method: string; headers: Record<string, string>; body: string };

/** A scripted stand-in for the network: answers by URL substring, records every call. */
function fakeFetch(routes: [match: string, status: number, body: unknown][]) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : "",
    });
    const route = routes.find(([match]) => url.includes(match));
    if (!route) return new Response("no route", { status: 599 });
    const [, status, body] = route;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as Fetch;
  return { impl, calls };
}

function signedShopifyParams(params: Record<string, string>, secret = shopifySecret) {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", secret).update(message).digest("hex");
  return new URLSearchParams({ ...params, hmac });
}

describe("Shopify store addresses", () => {
  it("accepts the forms people actually paste", () => {
    expect(normalizeShopDomain("wild-thread")).toBe("wild-thread.myshopify.com");
    expect(normalizeShopDomain("  Wild-Thread.myshopify.com ")).toBe("wild-thread.myshopify.com");
    expect(normalizeShopDomain("https://wild-thread.myshopify.com/admin/orders")).toBe(
      "wild-thread.myshopify.com",
    );
  });

  it("refuses anything that isn't a myshopify.com store", () => {
    for (const bad of [
      "",
      "evil.com",
      "wild-thread.myshopify.com.evil.com",
      "evil.com/wild-thread.myshopify.com",
      "wild_thread.myshopify.com",
      "-bad.myshopify.com",
      "admin.shopify.com",
      "a.b.myshopify.com",
    ]) {
      expect(normalizeShopDomain(bad), bad).toBeNull();
    }
  });
});

describe("Shopify signatures", () => {
  it("accepts a correctly signed callback and rejects tampering", () => {
    const params = signedShopifyParams({
      code: "abc",
      shop: "a.myshopify.com",
      state: "s",
      timestamp: "1",
    });
    expect(verifyShopifyQueryHmac(params, shopifySecret)).toBe(true);

    const tampered = new URLSearchParams(params);
    tampered.set("shop", "b.myshopify.com");
    expect(verifyShopifyQueryHmac(tampered, shopifySecret)).toBe(false);
    expect(
      verifyShopifyQueryHmac(signedShopifyParams({ code: "abc" }, "another-secret"), shopifySecret),
    ).toBe(false);
    expect(verifyShopifyQueryHmac(new URLSearchParams({ code: "abc" }), shopifySecret)).toBe(false);
    expect(
      verifyShopifyQueryHmac(new URLSearchParams({ code: "abc", hmac: "zz" }), shopifySecret),
    ).toBe(false);
  });

  it("verifies webhooks against the raw body", () => {
    const body = JSON.stringify({ id: 1, note: "héllo" });
    const good = createHmac("sha256", shopifySecret).update(body, "utf8").digest("base64");
    expect(verifyShopifyWebhookHmac(body, good, shopifySecret)).toBe(true);
    expect(verifyShopifyWebhookHmac(body + " ", good, shopifySecret)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, null, shopifySecret)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, "not-base64!!", shopifySecret)).toBe(false);
    const other = createHmac("sha256", "someone-else").update(body).digest("base64");
    expect(verifyShopifyWebhookHmac(body, other, shopifySecret)).toBe(false);
  });
});

describe("Shopify adapter", () => {
  const shopInfo = {
    data: {
      shop: {
        name: "Wild Thread",
        myshopifyDomain: "wild-thread.myshopify.com",
        currencyCode: "USD",
      },
    },
  };

  it("watch only asks the store for nothing that could change it", () => {
    const before = process.env.SHOPIFY_EXTRA_SCOPES;
    process.env.SHOPIFY_EXTRA_SCOPES =
      "read_all_orders, write_inventory, read_locations, write_merchant_managed_fulfillment_orders";
    try {
      const adapter = createShopifyAdapter(fakeFetch([]).impl);
      const asked = (access: string) => {
        const input: Record<string, string> = { shop: "wild-thread", access };
        const url = new URL(adapter.beginConnect({ state: "s", redirectUri: "x", input }));
        return { scopes: (url.searchParams.get("scope") ?? "").split(","), input };
      };
      const watch = asked("read");
      expect(watch.scopes).toEqual(
        expect.arrayContaining(["read_orders", "read_all_orders", "read_locations"]),
      );
      expect(watch.scopes.every((scope) => scope.startsWith("read_"))).toBe(true);
      // Reading what a write permission would have shown is kept, once.
      expect(watch.scopes).toContain("read_merchant_managed_fulfillment_orders");
      expect(watch.scopes.filter((scope) => scope === "read_inventory")).toHaveLength(1);
      expect(watch.input.access).toBe("read");

      const full = asked("full");
      expect(full.scopes).toContain("write_inventory");
      // Anything but the two known answers is the ordinary connection, never a wider one.
      expect(asked("everything").input.access).toBe("full");
    } finally {
      if (before === undefined) delete process.env.SHOPIFY_EXTRA_SCOPES;
      else process.env.SHOPIFY_EXTRA_SCOPES = before;
    }
  });

  it("sends the person to their own store to approve", () => {
    const adapter = createShopifyAdapter(fakeFetch([]).impl);
    const input = { shop: "Wild-Thread" };
    const url = new URL(
      adapter.beginConnect({ state: "nonce", redirectUri: "https://app.test/cb", input }),
    );
    expect(url.origin).toBe("https://wild-thread.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("state")).toBe("nonce");
    expect(url.searchParams.get("redirect_uri")).toBe("https://app.test/cb");
    expect(url.searchParams.get("scope")).toContain("read_orders");
    expect(input.shop).toBe("wild-thread.myshopify.com");
    expect((input as Record<string, string>).access).toBe("full");
    expect(() =>
      adapter.beginConnect({ state: "s", redirectUri: "x", input: { shop: "evil.com" } }),
    ).toThrow(ConnectError);
  });

  it("exchanges the code for an expiring token and names the store", async () => {
    const net = fakeFetch([
      [
        "/admin/oauth/access_token",
        200,
        {
          access_token: "shpat",
          scope: "read_orders,read_products",
          expires_in: 3600,
          refresh_token: "shprt",
          refresh_token_expires_in: 7776000,
        },
      ],
      ["/graphql.json", 200, shopInfo],
    ]);
    const adapter = createShopifyAdapter(net.impl);
    const params = signedShopifyParams({
      code: "abc",
      shop: "wild-thread.myshopify.com",
      state: "s",
      timestamp: "1",
    });
    const account = await adapter.completeConnect({
      params,
      redirectUri: "https://app.test/cb",
      input: { shop: "wild-thread.myshopify.com" },
    });

    expect(account.externalAccountId).toBe("wild-thread.myshopify.com");
    expect(account.displayName).toBe("Wild Thread");
    expect(account.scopes).toEqual(["read_orders", "read_products"]);
    expect(account.token.access_token).toBe("shpat");
    expect(account.token.refresh_token).toBe("shprt");
    expect(account.token.expires_at).toBeGreaterThan(Date.now());
    expect(JSON.parse(net.calls[0].body)).toMatchObject({ code: "abc", expiring: 1 });
    expect(net.calls[0].url).toBe("https://wild-thread.myshopify.com/admin/oauth/access_token");
  });

  it("refuses a callback that is unsigned or for a different store, before any network call", async () => {
    const net = fakeFetch([]);
    const adapter = createShopifyAdapter(net.impl);
    const finish = (params: URLSearchParams, shop = "wild-thread.myshopify.com") =>
      adapter.completeConnect({ params, redirectUri: "x", input: { shop } });

    await expect(
      finish(new URLSearchParams({ code: "abc", shop: "wild-thread.myshopify.com" })),
    ).rejects.toThrow(ConnectError);
    // Correctly signed by Shopify, but for a store other than the one this person started with.
    const otherShop = signedShopifyParams({ code: "abc", shop: "other.myshopify.com", state: "s" });
    await expect(finish(otherShop)).rejects.toThrow(/didn't match/);
    expect(net.calls).toHaveLength(0);
  });

  it("subscribes to store webhooks, tolerating ones that already exist", async () => {
    let n = 0;
    const net = fakeFetch([]);
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      await net.impl(input, init);
      n += 1;
      const userErrors =
        n === 2 ? [{ message: "Address for this topic has already been taken" }] : [];
      return new Response(JSON.stringify({ data: { webhookSubscriptionCreate: { userErrors } } }));
    }) as Fetch;
    const adapter = createShopifyAdapter(impl);
    await adapter.afterConnect!(
      {
        externalAccountId: "wild-thread.myshopify.com",
        displayName: "x",
        scopes: [],
        token: { access_token: "t" },
      },
      "https://app.test",
    );
    const topics = net.calls.map((c) => JSON.parse(c.body).variables.topic);
    expect(topics).toEqual([
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "CUSTOMERS_CREATE",
      "CUSTOMERS_UPDATE",
      "APP_UNINSTALLED",
    ]);
    expect(JSON.parse(net.calls[0].body).variables.sub.callbackUrl).toBe(
      "https://app.test/api/webhooks/shopify",
    );
  });

  it("rotates tokens on refresh and asks for a reconnect when Shopify refuses", async () => {
    const ok = fakeFetch([
      [
        "/admin/oauth/access_token",
        200,
        { access_token: "new", refresh_token: "new-r", expires_in: 3600 },
      ],
    ]);
    const rotated = await createShopifyAdapter(ok.impl).refresh(
      { access_token: "old", refresh_token: "old-r", expires_at: 1 },
      "wild-thread.myshopify.com",
    );
    expect(rotated).toMatchObject({ access_token: "new", refresh_token: "new-r" });
    expect(JSON.parse(ok.calls[0].body)).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "old-r",
    });

    const refused = fakeFetch([["/admin/oauth/access_token", 401, { error: "invalid_request" }]]);
    await expect(
      createShopifyAdapter(refused.impl).refresh(
        { access_token: "old", refresh_token: "dead" },
        "wild-thread.myshopify.com",
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);

    const down = fakeFetch([["/admin/oauth/access_token", 503, "busy"]]);
    await expect(
      createShopifyAdapter(down.impl).refresh(
        { access_token: "old", refresh_token: "r" },
        "wild-thread.myshopify.com",
      ),
    ).rejects.not.toBeInstanceOf(ReconnectRequiredError);
  });

  it("treats an uninstall or erase notice as the end of the connection", async () => {
    const adapter = createShopifyAdapter(fakeFetch([]).impl);
    const run = (topic: string) =>
      adapter.sync({
        store: memoryStore().store,
        connectionId: "c",
        externalAccountId: "",
        token: { access_token: "" },
        job: { type: "webhook", topic, payload: {}, cursor: null },
      });
    expect((await run("app/uninstalled")).disconnected).toBeTruthy();
    expect((await run("shop/redact")).disconnected).toBeTruthy();
    expect(await run("orders/create")).toEqual({});
  });

  it("asks for a reconnect when the store rejects the token during a sync", async () => {
    const adapter = createShopifyAdapter(fakeFetch([["/graphql.json", 401, "Unauthorized"]]).impl);
    await expect(
      adapter.sync({
        store: memoryStore().store,
        connectionId: "c",
        externalAccountId: "wild-thread.myshopify.com",
        token: { access_token: "t" },
        job: { type: "full", topic: null, payload: null, cursor: null },
      }),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });
});

describe("QuickBooks adapter", () => {
  const tokens = {
    access_token: "at",
    refresh_token: "rt-2",
    expires_in: 3600,
    x_refresh_token_expires_in: 8726400,
  };
  const company = { CompanyInfo: { CompanyName: "Wild Thread LLC", Country: "US" } };

  it("builds Intuit's approval link", () => {
    const url = new URL(
      createQuickBooksAdapter(fakeFetch([]).impl).beginConnect({
        state: "nonce",
        redirectUri: "https://app.test/cb",
        input: {},
      }),
    );
    expect(url.origin + url.pathname).toBe("https://appcenter.intuit.com/connect/oauth2");
    expect(url.searchParams.get("scope")).toBe("com.intuit.quickbooks.accounting");
    expect(url.searchParams.get("state")).toBe("nonce");
    expect(url.searchParams.get("client_id")).toBe("intuit-client");
  });

  it("exchanges the code, authenticates with the app's credentials, and names the company", async () => {
    const net = fakeFetch([
      ["/oauth2/v1/tokens/bearer", 200, tokens],
      ["/companyinfo/", 200, company],
    ]);
    const account = await createQuickBooksAdapter(net.impl).completeConnect({
      params: new URLSearchParams({ code: "abc", realmId: "4620816365", state: "s" }),
      redirectUri: "https://app.test/cb",
      input: {},
    });
    expect(account).toMatchObject({
      externalAccountId: "4620816365",
      displayName: "Wild Thread LLC",
    });
    expect(account.token.refresh_token).toBe("rt-2");

    const expected = "Basic " + Buffer.from(`intuit-client:${intuitSecret}`).toString("base64");
    expect(net.calls[0].headers.authorization).toBe(expected);
    expect(new URLSearchParams(net.calls[0].body).get("grant_type")).toBe("authorization_code");
    expect(net.calls[1].url).toContain(
      "sandbox-quickbooks.api.intuit.com/v3/company/4620816365/companyinfo/4620816365",
    );
    expect(net.calls[1].headers.authorization).toBe("Bearer at");
  });

  it("refuses a callback without a company id", async () => {
    const adapter = createQuickBooksAdapter(fakeFetch([]).impl);
    await expect(
      adapter.completeConnect({
        params: new URLSearchParams({ code: "abc" }),
        redirectUri: "x",
        input: {},
      }),
    ).rejects.toThrow(ConnectError);
    await expect(
      adapter.completeConnect({
        params: new URLSearchParams({ code: "abc", realmId: "../1" }),
        redirectUri: "x",
        input: {},
      }),
    ).rejects.toThrow(ConnectError);
  });

  it("keeps the rotated refresh token and asks for a reconnect on invalid_grant", async () => {
    const ok = fakeFetch([["/oauth2/v1/tokens/bearer", 200, tokens]]);
    const rotated = await createQuickBooksAdapter(ok.impl).refresh(
      { access_token: "old", refresh_token: "rt-1", expires_at: 1 },
      "1",
    );
    expect(rotated.refresh_token).toBe("rt-2");
    expect(new URLSearchParams(ok.calls[0].body).get("refresh_token")).toBe("rt-1");

    const refused = fakeFetch([["/oauth2/v1/tokens/bearer", 400, { error: "invalid_grant" }]]);
    await expect(
      createQuickBooksAdapter(refused.impl).refresh(
        { access_token: "old", refresh_token: "dead" },
        "1",
      ),
    ).rejects.toBeInstanceOf(ReconnectRequiredError);
  });

  it("revokes the refresh token on disconnect", async () => {
    const net = fakeFetch([["/oauth2/tokens/revoke", 200, ""]]);
    await createQuickBooksAdapter(net.impl).disconnect(
      { access_token: "at", refresh_token: "rt" },
      "1",
    );
    expect(JSON.parse(net.calls[0].body)).toEqual({ token: "rt" });
  });
});
