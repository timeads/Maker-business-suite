import { createQuickBooksAdapter } from "./providers/quickbooks";
import { createShopifyAdapter } from "./providers/shopify";
import type { ProviderAdapter, ProviderKey } from "./types";

const adapters: Record<ProviderKey, ProviderAdapter> = {
  shopify: createShopifyAdapter(),
  quickbooks: createQuickBooksAdapter(),
};

export const PROVIDER_ORDER: readonly ProviderKey[] = ["shopify", "quickbooks"];

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && value in adapters;
}

export function getAdapter(provider: ProviderKey): ProviderAdapter {
  return adapters[provider];
}
