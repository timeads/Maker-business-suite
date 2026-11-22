import { createHmac, timingSafeEqual } from "node:crypto";
import { ProviderHttpError, requestJson, requiredEnv } from "../http";
import { syncShopify } from "./shopify-sync";
import {
  ConnectError,
  ReconnectRequiredError,
  type ConnectedAccount,
  type Fetch,
  type ProviderAdapter,
  type TokenSet,
} from "../types";

const BASE_SCOPES = ["read_orders", "read_customers", "read_products", "read_inventory"];
/**
 * Extra scopes Shopify has approved for the app, comma separated. Without
 * `read_all_orders`, Shopify only returns the last 60 days of orders.
 */
const scopes = () => [
  ...BASE_SCOPES,
  ...(process.env.SHOPIFY_EXTRA_SCOPES ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean),
];
const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "CUSTOMERS_CREATE",
  "CUSTOMERS_UPDATE",
  "APP_UNINSTALLED",
];
/** Privacy webhooks every public app must accept. Configured in the Shopify app settings. */
export const SHOPIFY_COMPLIANCE_TOPICS = [
  "customers/data_request",
  "customers/redact",
  "shop/redact",
];

export const shopifyApiVersion = () => process.env.SHOPIFY_API_VERSION || "2026-10";

/** Accepts "my-store", "my-store.myshopify.com" or a pasted admin URL; returns the canonical domain. */
export function normalizeShopDomain(input: string): string | null {
  let value = input.trim().toLowerCase();
  value = value.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!value.includes(".")) value = `${value}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$/.test(value) ? value : null;
}

function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checks the `hmac` Shopify adds to OAuth callback query strings. */
export function verifyShopifyQueryHmac(params: URLSearchParams, secret: string): boolean {
  const given = params.get("hmac");
  if (!given || !/^[0-9a-f]+$/i.test(given)) return false;
  const message = [...params.entries()]
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const expected = createHmac("sha256", secret).update(message).digest();
  return safeEqual(expected, Buffer.from(given, "hex"));
}

/** Checks the signature on a webhook's raw body. */
export function verifyShopifyWebhookHmac(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
  return safeEqual(expected, Buffer.from(header, "base64"));
}

type TokenResponse = {
  access_token: string;
  scope?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
};

function toTokenSet(response: TokenResponse, now: number): TokenSet {
  return {
    access_token: response.access_token,
    ...(response.refresh_token ? { refresh_token: response.refresh_token } : {}),
    ...(response.expires_in ? { expires_at: now + response.expires_in * 1000 } : {}),
    ...(response.refresh_token_expires_in
      ? { refresh_expires_at: now + response.refresh_token_expires_in * 1000 }
      : {}),
  };
}

export function createShopifyAdapter(fetchImpl: Fetch = fetch): ProviderAdapter {
  const clientId = () => requiredEnv("SHOPIFY_CLIENT_ID");
  const clientSecret = () => requiredEnv("SHOPIFY_CLIENT_SECRET");

  async function graphql<T>(shop: string, token: TokenSet, query: string, variables?: object) {
    try {
      const result = await requestJson<{ data?: T; errors?: unknown }>(
        fetchImpl,
        "Shopify",
        `https://${shop}/admin/api/${shopifyApiVersion()}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": token.access_token,
          },
          body: JSON.stringify({ query, variables }),
        },
      );
      if (result.errors || !result.data) {
        throw new ProviderHttpError("Shopify", 200, "GraphQL request returned errors");
      }
      return result.data;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 401) {
        throw new ReconnectRequiredError("Shopify no longer accepts this store's access");
      }
      throw err;
    }
  }

  type ShopInfo = { shop: { name: string; myshopifyDomain: string; currencyCode: string } };
  const shopInfo = (shop: string, token: TokenSet) =>
    graphql<ShopInfo>(shop, token, "{ shop { name myshopifyDomain currencyCode } }");

  return {
    key: "shopify",
    name: "Shopify",
    blurb: "Orders, customers and products from your store",
    connectFields: [
      {
        name: "shop",
        label: "Your store's address",
        placeholder: "your-store.myshopify.com",
        help: "The .myshopify.com address you see in your Shopify admin.",
      },
    ],
    pollEveryHours: null,
    configured: () => Boolean(process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET),

    beginConnect({ state, redirectUri, input }) {
      const shop = normalizeShopDomain(input.shop ?? "");
      if (!shop) {
        throw new ConnectError(
          "That doesn't look like a Shopify store address. It ends in .myshopify.com.",
        );
      }
      input.shop = shop;
      const url = new URL(`https://${shop}/admin/oauth/authorize`);
      url.searchParams.set("client_id", clientId());
      url.searchParams.set("scope", scopes().join(","));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async completeConnect({ params, input }): Promise<ConnectedAccount> {
      if (!verifyShopifyQueryHmac(params, clientSecret())) {
        throw new ConnectError(
          "We couldn't confirm that response came from Shopify. Try connecting again.",
        );
      }
      const shop = normalizeShopDomain(params.get("shop") ?? "");
      const code = params.get("code");
      // The store that answered must be the one this person set out to connect.
      if (!shop || !code || shop !== input.shop) {
        throw new ConnectError(
          "Shopify's response didn't match the store you entered. Try connecting again.",
        );
      }

      const now = Date.now();
      const response = await requestJson<TokenResponse>(
        fetchImpl,
        "Shopify",
        `https://${shop}/admin/oauth/access_token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          // New public apps must use expiring offline tokens.
          body: JSON.stringify({
            client_id: clientId(),
            client_secret: clientSecret(),
            code,
            expiring: 1,
          }),
        },
      );
      const token = toTokenSet(response, now);
      const info = await shopInfo(shop, token);
      return {
        externalAccountId: shop,
        displayName: info.shop.name,
        scopes: (response.scope ?? "").split(",").filter(Boolean),
        token,
        metadata: { currency: info.shop.currencyCode },
      };
    },

    async afterConnect(account, siteUrl) {
      const callbackUrl = `${siteUrl}/api/webhooks/shopify`;
      const mutation = `mutation($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) {
          userErrors { message }
        }
      }`;
      for (const topic of WEBHOOK_TOPICS) {
        const result = await graphql<{
          webhookSubscriptionCreate: { userErrors: { message: string }[] };
        }>(account.externalAccountId, account.token, mutation, {
          topic,
          sub: { callbackUrl, format: "JSON" },
        });
        const errors = result.webhookSubscriptionCreate.userErrors;
        // Reconnecting a store finds the subscriptions already there.
        const real = errors.filter((e) => !/already been taken|already exists/i.test(e.message));
        if (real.length > 0) {
          throw new ProviderHttpError("Shopify", 200, `Could not subscribe to ${topic}`);
        }
      }
    },

    async refresh(token, shop) {
      if (!token.refresh_token) return token;
      const now = Date.now();
      try {
        const response = await requestJson<TokenResponse>(
          fetchImpl,
          "Shopify",
          `https://${shop}/admin/oauth/access_token`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({
              client_id: clientId(),
              client_secret: clientSecret(),
              grant_type: "refresh_token",
              refresh_token: token.refresh_token,
            }),
          },
        );
        return toTokenSet(response, now);
      } catch (err) {
        if (err instanceof ProviderHttpError && (err.status === 400 || err.status === 401)) {
          throw new ReconnectRequiredError("Shopify rejected the saved access for this store");
        }
        throw err;
      }
    },

    async disconnect(token, shop) {
      // Uninstalls the app from the store, which also revokes the token.
      await requestJson(
        fetchImpl,
        "Shopify",
        `https://${shop}/admin/api_permissions/current.json`,
        {
          method: "DELETE",
          headers: { "X-Shopify-Access-Token": token.access_token },
        },
      );
    },

    tokenlessTopics: ["app/uninstalled", ...SHOPIFY_COMPLIANCE_TOPICS],

    sync: (ctx) => syncShopify(ctx, graphql),
  };
}
