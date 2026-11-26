import { describe, expect, it } from "vitest";
import { canTagInShopify } from "../bookings/shop-tags";
import { canCheckAgain, shopPermission, shopPermissionWords } from "./shop-permission";

const tags = (shop: Parameters<typeof shopPermission>[0]) => shopPermission(shop, canTagInShopify);

describe("shopPermission", () => {
  it("is allowed only when the store reported the scope", () => {
    expect(tags({ status: "active", scopes: ["read_orders", "write_orders"] }).state).toBe(
      "allowed",
    );
    expect(tags({ status: "active", scopes: ["read_orders"] }).state).toBe("not_granted");
  });

  it("tells asked-but-not-granted apart from never asked", () => {
    const asked = tags({
      status: "active",
      scopes: ["read_orders"],
      metadata: { asked_scopes: ["read_orders", "write_orders"], scopes_checked_at: "2026-11-26" },
    });
    expect(asked).toEqual({ state: "asked_not_granted", checkedAt: "2026-11-26" });
    expect(canCheckAgain(asked)).toBe(true);
    expect(tags({ status: "active", scopes: [], metadata: { asked_scopes: "nope" } }).state).toBe(
      "not_granted",
    );
  });

  it("never calls a watch-only shop allowed, whatever is on record", () => {
    const watching = tags({
      status: "active",
      scopes: ["write_orders"],
      metadata: { watch_only: true },
    });
    expect(watching.state).toBe("watch_only");
    expect(canCheckAgain(watching)).toBe(false);
  });

  it("knows a missing or broken connection", () => {
    expect(tags(null).state).toBe("not_connected");
    expect(tags({ status: "disconnected", scopes: ["write_orders"] }).state).toBe("not_connected");
    expect(tags({ status: "needs_reconnect", scopes: ["write_orders"] }).state).toBe("reconnect");
  });

  it("has words for every state, and says what to do when Shopify said no", () => {
    const words = shopPermissionWords("asked_not_granted", "add tags to its orders");
    expect(words.headline).toContain("didn't give it");
    expect(words.next).toContain("Check again");
    expect(words.next).toContain("connecting again won't change this");
    expect(shopPermissionWords("allowed", "x").next).toBeNull();
  });
});
