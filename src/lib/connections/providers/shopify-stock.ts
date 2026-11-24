import { ProviderHttpError, requestJson } from "../http";
import { ReconnectRequiredError, type Fetch, type TokenSet } from "../types";
import { shopifyApiVersion } from "./shopify";

/**
 * Adds units someone checked in to the shop's own count. The only place we
 * ever change a number in the shop, and it only ever adds.
 */

export class StockWriteError extends Error {}
/**
 * The shop was asked to add the units and we never heard a clear answer (the
 * line dropped, or it answered with something we can't read). It may or may
 * not have added them, so this one is never offered to the shop again.
 */
export class StockWriteUnsureError extends StockWriteError {}

const LOCATIONS = `{ locations(first: 10) { nodes { id name isActive } } }`;
// The shop asks for a key with every change to a count (required since its
// 2026-04 version): the same key sent twice is one change, not two.
const ADJUST = `mutation Adjust($input: InventoryAdjustQuantitiesInput!, $key: String!) {
  inventoryAdjustQuantities(input: $input) @idempotent(key: $key) {
    userErrors { field message }
    inventoryAdjustmentGroup { createdAt }
  }
}`;

export const canWriteShopifyStock = (scopes: unknown): boolean =>
  Array.isArray(scopes) && scopes.includes("write_inventory") && scopes.includes("read_locations");

export function createShopifyStockWriter(fetchImpl: Fetch = fetch) {
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
        throw new StockWriteError("The shop turned the request down");
      }
      return result.data;
    } catch (err) {
      if (err instanceof ProviderHttpError && err.status === 401) {
        throw new ReconnectRequiredError("Shopify no longer accepts this store's access");
      }
      throw err;
    }
  }

  return {
    /**
     * Adds `delta` units to one inventory item at the shop's main location.
     * `key` names this one try. Anything thrown before the shop is asked, and
     * a plain "no" from the shop, is a StockWriteError (nothing was added);
     * an unclear answer to the change itself is a StockWriteUnsureError.
     */
    async add(
      shop: string,
      token: TokenSet,
      change: { inventoryItemId: string; delta: number; reference: string; key: string },
    ): Promise<void> {
      if (!(change.delta > 0)) throw new StockWriteError("Only arrivals are added to the shop");
      const places = await graphql<{
        locations: { nodes: { id: string; name: string; isActive: boolean }[] };
      }>(shop, token, LOCATIONS);
      const active = places.locations.nodes.filter((place) => place.isActive);
      if (active.length === 0) throw new StockWriteError("The shop has no active location");
      if (active.length > 1) {
        // Guessing which shelf it went on would put the count wrong somewhere.
        throw new StockWriteError(
          "The shop keeps stock in more than one place, so add this delivery there by hand",
        );
      }
      let result: { inventoryAdjustQuantities: { userErrors: { message: string }[] } | null };
      try {
        result = await graphql(shop, token, ADJUST, {
          key: change.key,
          input: {
            reason: "received",
            name: "available",
            referenceDocumentUri: change.reference,
            changes: [
              {
                delta: change.delta,
                inventoryItemId: change.inventoryItemId,
                locationId: active[0].id,
              },
            ],
          },
        });
      } catch (err) {
        // Signed out means the shop did nothing. Anything else: we can't know.
        if (err instanceof ReconnectRequiredError) throw err;
        throw new StockWriteUnsureError(
          `We couldn't tell whether your shop added it (${
            err instanceof Error ? err.message : "no answer"
          })`.slice(0, 300),
        );
      }
      if (!result.inventoryAdjustQuantities) {
        throw new StockWriteUnsureError("We couldn't tell whether your shop added it");
      }
      const errors = result.inventoryAdjustQuantities.userErrors;
      if (errors.length > 0) {
        throw new StockWriteError(
          errors
            .map((e) => e.message)
            .join("; ")
            .slice(0, 300),
        );
      }
    },
  };
}
