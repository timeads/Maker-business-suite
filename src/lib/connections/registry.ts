import { createEasyPostAdapter } from "./providers/easypost";
import { createEventbriteAdapter } from "./providers/eventbrite";
import { createGoogleMailAdapter } from "./providers/google-mail";
import { createMetaAdapter } from "./providers/meta";
import { createMichaelsAdapter } from "./providers/michaels";
import { createQuickBooksAdapter } from "./providers/quickbooks";
import { createRedoAdapter } from "./providers/redo";
import { createShopifyAdapter } from "./providers/shopify";
import { createStripeAdapter } from "./providers/stripe";
import { createTwilioAdapter } from "./providers/twilio";
import { createUpsAdapter } from "./providers/ups";
import type { ProviderAdapter, ProviderKey } from "./types";

const adapters: Record<ProviderKey, ProviderAdapter> = {
  shopify: createShopifyAdapter(),
  quickbooks: createQuickBooksAdapter(),
  stripe: createStripeAdapter(),
  meta: createMetaAdapter(),
  easypost: createEasyPostAdapter(),
  ups: createUpsAdapter(),
  redo: createRedoAdapter(),
  google_mail: createGoogleMailAdapter(),
  michaels: createMichaelsAdapter(),
  twilio: createTwilioAdapter(),
  eventbrite: createEventbriteAdapter(),
};

export const PROVIDER_ORDER: readonly ProviderKey[] = [
  "shopify",
  "quickbooks",
  "stripe",
  "meta",
  "easypost",
  "ups",
  "redo",
  "google_mail",
  "michaels",
  "twilio",
  "eventbrite",
];

export function isProviderKey(value: unknown): value is ProviderKey {
  return typeof value === "string" && value in adapters;
}

export function getAdapter(provider: ProviderKey): ProviderAdapter {
  return adapters[provider];
}
