import { describe, expect, it } from "vitest";
import { requiredItems } from "../setup/items";
import {
  SHIPPING_STEPS,
  shippingOrderFacts,
  shippingSetupItems,
  type ShippingSetupFacts,
} from "./setup";

const NOW = new Date("2026-11-27T15:00:00Z");
const fresh = { status: "active" as const, lastSyncedAt: "2026-11-27T12:00:00Z", lastError: null };

/** A workspace with nothing left to do. */
const done = (more: Partial<ShippingSetupFacts> = {}): ShippingSetupFacts => ({
  now: NOW,
  shop: fresh,
  recent: { shop: 40, shipping: 38 },
  open: { toPost: 20, noAddress: 0, noWeight: 0 },
  shipFromMissing: [],
  boxes: { count: 3, usualMarked: true },
  postage: { active: ["easypost"], needsReconnect: [], testMode: [] },
  permission: { state: "allowed", checkedAt: null },
  slip: { saved: true, logoWanted: true, logo: true },
  rules: { count: 1, signatureOver: null },
  ...more,
});
const ids = (facts: ShippingSetupFacts) => shippingSetupItems(facts).map((item) => item.id);
const one = (facts: ShippingSetupFacts, id: string) =>
  shippingSetupItems(facts).find((item) => item.id === id);

describe("shippingSetupItems", () => {
  it("has nothing to say when everything is in place", () => {
    expect(shippingSetupItems(done())).toEqual([]);
  });

  it("asks for the shop first", () => {
    expect(ids(done({ shop: null }))).toContain("shop.connect");
    expect(ids(done({ shop: { ...fresh, status: "needs_reconnect" } }))).toContain(
      "shop.reconnect",
    );
    expect(one(done({ shop: null }), "shop.connect")?.to).toBe("connections");
  });

  it("says when the shop's orders come in but their addresses don't", () => {
    expect(ids(done({ recent: { shop: 12, shipping: 0 } }))).toEqual(["shop.addresses"]);
    // Too few orders to tell, or none charged postage.
    expect(ids(done({ recent: { shop: 2, shipping: 0 } }))).toEqual([]);
    // Not while the shop isn't connected.
    expect(ids(done({ shop: null, recent: { shop: 12, shipping: 0 } }))).not.toContain(
      "shop.addresses",
    );
  });

  it("says when many waiting orders have no address", () => {
    expect(
      one(done({ open: { toPost: 10, noAddress: 5, noWeight: 0 } }), "orders.no-address"),
    ).toMatchObject({
      title: "5 orders waiting have no address",
      count: 5,
      facts: "5",
    });
    expect(ids(done({ open: { toPost: 10, noAddress: 2, noWeight: 0 } }))).toEqual([]);
    expect(ids(done({ open: { toPost: 100, noAddress: 3, noWeight: 0 } }))).toEqual([]);
  });

  it("asks to finish the ship-from address, naming what's missing", () => {
    expect(
      one(done({ shipFromMissing: ["street address", "phone number"] }), "from.address"),
    ).toMatchObject({ names: ["street address", "phone number"], managersOnly: true });
  });

  it("asks for a box, then for the usual one when there are several", () => {
    expect(ids(done({ boxes: { count: 0, usualMarked: false } }))).toEqual(["boxes.none"]);
    expect(ids(done({ boxes: { count: 2, usualMarked: false } }))).toEqual(["boxes.usual"]);
    expect(ids(done({ boxes: { count: 1, usualMarked: false } }))).toEqual([]);
  });

  it("asks to reconnect a postage account or swap practice labels for real ones", () => {
    expect(
      one(
        done({ postage: { active: [], needsReconnect: ["ups"], testMode: [] } }),
        "labels.reconnect",
      )?.title,
    ).toBe("UPS needs connecting again");
    expect(
      one(
        done({ postage: { active: ["easypost"], needsReconnect: [], testMode: ["easypost"] } }),
        "labels.practice",
      )?.title,
    ).toBe("EasyPost is buying practice labels");
  });

  it("offers a postage account as optional: recording parcels by hand is fine", () => {
    const item = one(
      done({ postage: { active: [], needsReconnect: [], testMode: [] } }),
      "labels.none",
    );
    expect(item).toMatchObject({ optional: true, managersOnly: true });
    expect(item?.why).toMatch(/record parcels by hand/);
  });

  it("asks for weights only where labels are bought here", () => {
    const heavy = { open: { toPost: 10, noAddress: 0, noWeight: 4 } };
    expect(one(done(heavy), "weights.missing")).toMatchObject({ count: 4 });
    expect(one(done(heavy), "weights.missing")?.managersOnly).toBeUndefined();
    expect(
      ids(done({ ...heavy, postage: { active: [], needsReconnect: [], testMode: [] } })),
    ).not.toContain("weights.missing");
    expect(ids(done({ open: { toPost: 10, noAddress: 0, noWeight: 1 } }))).toEqual([]);
  });

  it("offers the shop's permission as optional, and says nothing for watch-only (a fine choice)", () => {
    expect(
      one(done({ permission: { state: "not_granted", checkedAt: null } }), "shop.permission")
        ?.optional,
    ).toBe(true);
    expect(
      one(done({ permission: { state: "asked_not_granted", checkedAt: null } }), "shop.permission"),
    ).toBeTruthy();
    expect(ids(done({ permission: { state: "watch_only", checkedAt: null } }))).toEqual([]);
  });

  it("offers the slip and a logo as optional", () => {
    expect(
      one(done({ slip: { saved: false, logoWanted: true, logo: true } }), "slip.layout")?.title,
    ).toBe("Make the packing slip yours");
    expect(
      one(done({ slip: { saved: true, logoWanted: true, logo: false } }), "slip.layout")?.title,
    ).toBe("Add your logo to the packing slip");
    expect(ids(done({ slip: { saved: true, logoWanted: false, logo: false } }))).toEqual([]);
  });

  it("offers rules as optional, unless the signature setting is already one", () => {
    expect(one(done({ rules: { count: 0, signatureOver: null } }), "rules")?.optional).toBe(true);
    expect(ids(done({ rules: { count: 0, signatureOver: 250 } }))).toEqual([]);
  });

  it("keeps optional items off the card and every item in a step that exists", () => {
    const all = shippingSetupItems(
      done({
        shop: { ...fresh, lastSyncedAt: null },
        shipFromMissing: ["street address"],
        boxes: { count: 0, usualMarked: false },
        postage: { active: [], needsReconnect: [], testMode: [] },
        permission: { state: "not_granted", checkedAt: null },
        slip: { saved: false, logoWanted: true, logo: false },
        rules: { count: 0, signatureOver: null },
      }),
    );
    expect(requiredItems(all).map((i) => i.id)).toEqual([
      "shop.first-read",
      "from.address",
      "boxes.none",
    ]);
    const steps = new Set(SHIPPING_STEPS.map((s) => s.id));
    expect(all.every((item) => steps.has(item.step))).toBe(true);
  });
});

describe("shippingOrderFacts", () => {
  const order = (more: Partial<Parameters<typeof shippingOrderFacts>[0][number]> = {}) => ({
    pickup: false,
    country_code: "US",
    address1: "1 Mill Lane",
    recipient: "Sam",
    weight_grams: null,
    items: [{ left: 1, grams: 200 }],
    ...more,
  });

  it("counts orders to post, those with no address and those with no weight", () => {
    expect(
      shippingOrderFacts(
        [
          order(),
          order({ items: [{ left: 1, grams: null }] }),
          order({ items: [{ left: 1, grams: null }], weight_grams: 900 }),
          order({ address1: null, items: [{ left: 1, grams: null }] }),
          order({ pickup: true }),
          order({ country_code: "CA" }),
          // Already sent: its missing weight doesn't matter.
          order({
            items: [
              { left: 0, grams: null },
              { left: 1, grams: 50 },
            ],
          }),
        ],
        "US",
      ),
    ).toEqual({ toPost: 5, noAddress: 1, noWeight: 1 });
  });
});
