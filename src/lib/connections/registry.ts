import { createEasyPostAdapter } from "./providers/easypost";
import { createMetaAdapter } from "./providers/meta";
import { createQuickBooksAdapter } from "./providers/quickbooks";
import { createShopifyAdapter } from "./providers/shopify";
import { createStripeAdapter } from "./providers/stripe";
import type { ProviderAdapter, ProviderKey } from "./types";

const adapters: Record<ProviderKey, ProviderAdapter> = {
  shopify: createShopifyAdapter(),
  quickbooks: createQuickBooksAdapter(),
  stripe: createStripeAdapter(),
  meta: createMetaAdapter(),
  easypost: createEasyPostAdapter(),
};

export const PROVIDER_ORDER: readonly ProviderKey[] = [
  "shopify",
  "quickbooks",
  "stripe",
  "meta",
  "easypost",
];

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && value in adapters;
}

export function getAdapter(provider: ProviderKey): ProviderAdapter {
  return adapters[provider];
}
