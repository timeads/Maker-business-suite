import { describe, expect, it } from "vitest";
import {
  addressKey,
  addressLine,
  checkGroup,
  combineOrders,
  dismissedKeys,
  groupHref,
  groupKey,
  groupName,
  isApproved,
  knownGroupOf,
  liveSavedGroups,
  mergeSuggestions,
  parseWith,
  type MergeOrder,
  type StoredGroup,
} from "./merge";

const TODAY = "2026-10-10";
const addr = (over: Partial<MergeOrder> = {}) => ({
  recipient: "Jane Doe",
  address1: "12 Oak Street",
  address2: "Apt 3",
  city: "Philadelphia",
  region: "PA",
  postal_code: "19107-1234",
  country_code: "US",
  ...over,
});
const id = (n: number | string) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const q = (n: number, placed: string, over: Partial<MergeOrder> = {}): MergeOrder => ({
  id: id(n),
  name: `#${n}`,
  placed_at: `${placed}T12:00:00Z`,
  ...addr(),
  units_left: 1,
  cancelled: false,
  paid: true,
  on_hold: false,
  hold_until: null,
  pickup: false,
  picked_up_at: null,
  shipping_paid: 5,
  weight_grams: 100,
  items: [{ line_id: "l1", title: "Yarn", variant: null, sku: null, qty: 1, left: 1 }],
  ...over,
});

describe("the same address", () => {
  it("matches the same person and address despite spelling differences", () => {
    expect(addressKey(addr())).toBe(
      addressKey(
        addr({
          recipient: "jane doe",
          address1: "12 Oak St.",
          address2: "#3",
          postal_code: "19107",
        }),
      ),
    );
    expect(addressKey(addr())).not.toBe(addressKey(addr({ address2: "Apt 4" })));
    expect(addressKey(addr())).not.toBe(addressKey(addr({ recipient: "John Doe" })));
    expect(addressKey(addr({ address1: null }))).toBeNull();
    expect(addressKey(addr({ address1: "  " }))).toBeNull();
  });

  it("ignores capitals, and an apartment on either address line", () => {
    const key = addressKey(addr());
    expect(
      addressKey(addr({ recipient: "JANE DOE", address1: "12 OAK STREET", address2: "APT 3" })),
    ).toBe(key);
    expect(addressKey(addr({ address1: "12 Oak St Apt 3", address2: null }))).toBe(key);
    expect(addressKey(addr({ address1: "12 Oak St, #3", address2: "" }))).toBe(key);
    expect(addressKey(addr({ address1: "12 North Oak Street" }))).toBe(
      addressKey(addr({ address1: "12 N. Oak St" })),
    );
  });

  it("ignores accents, keeps a whole postcode abroad and never mixes countries", () => {
    expect(addressKey(addr({ recipient: "José Núñez" }))).toBe(
      addressKey(addr({ recipient: "Jose Nunez" })),
    );
    const uk = addr({ country_code: "GB", postal_code: "SW1A 1AA" });
    expect(addressKey(uk)).toBe(addressKey({ ...uk, postal_code: "sw1a1aa" }));
    expect(addressKey(uk)).not.toBe(addressKey({ ...uk, postal_code: "SW1A 1AB" }));
    expect(addressKey(addr({ country_code: "CA" }))).not.toBe(addressKey(addr()));
    // A shop that left the country off is read as a US postcode.
    expect(addressKey(addr({ country_code: null }))).toContain("|19107|");
  });

  it("writes an address on one line", () => {
    expect(addressLine(addr())).toBe("Jane Doe, 12 Oak Street, Apt 3, Philadelphia PA 19107-1234");
  });
});

describe("suggesting orders to ship together", () => {
  const orders = [
    q(3, "2026-10-03", { units_left: 2 }),
    q(1, "2026-10-01"),
    q(2, "2026-10-02", { address1: "12 Oak St" }),
    q(4, "2026-10-04", { units_left: 0 }),
    q(5, "2026-10-04", { on_hold: true }),
    q(6, "2026-10-04", { pickup: true }),
    q(7, "2026-10-04", { recipient: "Bob", address1: "9 Elm Rd" }),
    q(8, "2026-10-04", { paid: false }),
    q(9, "2026-10-04", { cancelled: true }),
  ];

  it("suggests 2+ shippable orders to one address, oldest first, and skips ones already handled", () => {
    const found = mergeSuggestions(orders, new Set(), TODAY);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      orderIds: [id(1), id(2), id(3)],
      names: ["#1", "#2", "#3"],
      customer: "Jane Doe",
      items: 4,
      address: "12 Oak Street, Apt 3, Philadelphia PA 19107-1234",
    });
    expect(mergeSuggestions(orders, new Set([found[0].key]), TODAY)).toEqual([]);
    // A new order to the same address makes a new suggestion even after "Not now".
    expect(
      mergeSuggestions([...orders, q(10, "2026-10-05")], new Set([found[0].key]), TODAY),
    ).toHaveLength(1);
  });

  it("lets a hold whose day has come back in, and a part-sent order with what is left", () => {
    const back = q(5, "2026-10-04", { on_hold: true, hold_until: TODAY });
    const part = q(11, "2026-10-06", {
      units_left: 1,
      items: [{ line_id: "l1", title: "Yarn", variant: null, sku: null, qty: 3, left: 1 }],
    });
    const [group] = mergeSuggestions([q(1, "2026-10-01"), back, part], new Set(), TODAY);
    expect(group.names).toEqual(["#1", "#5", "#11"]);
    expect(group.items).toBe(3);
  });

  it("never suggests more than ten at once", () => {
    const many = Array.from({ length: 12 }, (_, n) => q(n + 1, "2026-10-01"));
    expect(mergeSuggestions(many, new Set(), TODAY)[0].orderIds).toHaveLength(10);
  });

  it("remembers dismissed suggestions by the orders in them", () => {
    const stored: StoredGroup[] = [
      { order_ids: [id(2), id(1)], saved_at: null, dismissed_at: "2026-10-09", approved_at: null },
      { order_ids: [id(3), id(4)], saved_at: "2026-10-09", dismissed_at: null, approved_at: null },
    ];
    expect([...dismissedKeys(stored)]).toEqual([groupKey([id(1), id(2)])]);
    expect(groupKey([id(2), id(1), id(2)])).toBe(`${id(1)},${id(2)}`);
  });
});

describe("checking a group", () => {
  const jane = [q(2, "2026-10-02"), q(1, "2026-10-01")];
  const ids = jane.map((order) => order.id);

  it("takes two to ten orders and puts the oldest first", () => {
    const check = checkGroup(ids, jane, false, TODAY);
    expect(check.ok && check.orders.map((order) => order.name)).toEqual(["#1", "#2"]);
    expect(checkGroup([id(1)], jane, false, TODAY)).toMatchObject({ ok: false, reason: "count" });
    expect(checkGroup([id(1), id(1)], jane, false, TODAY)).toMatchObject({ reason: "count" });
    const many = Array.from({ length: 11 }, (_, n) => q(n + 1, "2026-10-01"));
    expect(
      checkGroup(
        many.map((order) => order.id),
        many,
        false,
        TODAY,
      ),
    ).toMatchObject({ ok: false, reason: "count" });
    expect(checkGroup([id(1), id(99)], jane, false, TODAY)).toMatchObject({ reason: "missing" });
  });

  it("refuses an order that is sent, cancelled, on hold, a pickup or has no address", () => {
    const withOne = (over: Partial<MergeOrder>) =>
      checkGroup(ids, [jane[1], q(2, "2026-10-02", over)], false, TODAY);
    expect(withOne({ units_left: 0 })).toMatchObject({ ok: false, reason: "closed" });
    expect(withOne({ cancelled: true })).toMatchObject({ ok: false, reason: "closed" });
    expect(withOne({ on_hold: true })).toMatchObject({ ok: false, reason: "hold" });
    expect(withOne({ pickup: true })).toMatchObject({ ok: false, reason: "pickup" });
    expect(withOne({ address1: null })).toMatchObject({ ok: false, reason: "no_address" });
    // Payment pending isn't suggested, but a person may still pick it.
    expect(withOne({ paid: false }).ok).toBe(true);
    expect(withOne({ on_hold: true, hold_until: TODAY }).ok).toBe(true);
  });

  it("shows both addresses when they differ, and lets them through once a teammate says they're the same place", () => {
    const other = [jane[1], q(2, "2026-10-02", { address1: "14 Oak Street" })];
    const check = checkGroup(ids, other, false, TODAY);
    expect(check).toMatchObject({ ok: false, reason: "mismatch" });
    expect(!check.ok && check.addresses).toEqual([
      { name: "#1", address: "Jane Doe, 12 Oak Street, Apt 3, Philadelphia PA 19107-1234" },
      { name: "#2", address: "Jane Doe, 14 Oak Street, Apt 3, Philadelphia PA 19107-1234" },
    ]);
    expect(checkGroup(ids, other, true, TODAY).ok).toBe(true);
    // An approval never makes up for a missing address.
    expect(
      checkGroup(ids, [jane[1], q(2, "2026-10-02", { address1: null })], true, TODAY),
    ).toMatchObject({ reason: "no_address" });
  });
});

describe("combining orders into one", () => {
  it("is the oldest order's details with every item and summed totals", () => {
    const duo = q(1, "2026-10-01", {
      shipping_paid: "12.50",
      weight_grams: 4000,
      units_left: 1,
      items: [{ line_id: "l1", title: "The Duo", variant: null, sku: "DUO", qty: 1, left: 1 }],
    });
    const yarn = q(2, "2026-10-02", {
      recipient: "J. Doe",
      shipping_paid: 5.1,
      weight_grams: 250,
      units_left: 2,
      items: [{ line_id: "l1", title: "Yarn", variant: "Red", sku: null, qty: 3, left: 2 }],
    });
    const combined = combineOrders([yarn, duo]);
    expect(combined.id).toBe(id(1));
    expect(combined.recipient).toBe("Jane Doe");
    expect(combined.name).toBe("#1 + #2");
    expect(combined.order_ids).toEqual([id(1), id(2)]);
    expect(combined.items.map((item) => [item.title, item.order_name, item.own_line_id])).toEqual([
      ["The Duo", "#1", "l1"],
      ["Yarn", "#2", "l1"],
    ]);
    // Two orders' "l1" stay apart.
    expect(new Set(combined.items.map((item) => item.line_id)).size).toBe(2);
    expect(combined.shipping_paid).toBe(17.6);
    expect(combined.weight_grams).toBe(4250);
    expect(combined.units_left).toBe(3);
  });

  it("doesn't guess a weight or a shipping charge it wasn't given", () => {
    const combined = combineOrders([
      q(1, "2026-10-01", { weight_grams: null, shipping_paid: null }),
      q(2, "2026-10-02", { shipping_paid: null }),
    ]);
    expect(combined.weight_grams).toBeNull();
    expect(combined.shipping_paid).toBeNull();
    expect(
      combineOrders([q(1, "2026-10-01", { shipping_paid: null }), q(2, "2026-10-02")])
        .shipping_paid,
    ).toBe(5);
  });

  it("names a group by its orders", () => {
    expect(groupName([{ name: "#1042" }, { name: "#1055" }])).toBe("#1042 + #1055");
  });
});

describe("groups people saved or approved", () => {
  const orders = [
    q(1, "2026-10-01"),
    q(2, "2026-10-02"),
    q(3, "2026-10-03", { address1: "9 Elm" }),
  ];
  const saved = (ids: string[], over: Partial<StoredGroup> = {}): StoredGroup => ({
    order_ids: ids,
    saved_at: "2026-10-09T10:00:00Z",
    dismissed_at: null,
    approved_at: null,
    ...over,
  });

  it("shows a saved group while every order is still waiting", () => {
    const groups = [saved([id(2), id(1)])];
    expect(liveSavedGroups(groups, orders, TODAY)).toMatchObject([
      { orderIds: [id(1), id(2)], names: ["#1", "#2"], savedAt: "2026-10-09T10:00:00Z" },
    ]);
    // One of them went out on its own: nothing left to finish together.
    expect(liveSavedGroups(groups, [orders[0]], TODAY)).toEqual([]);
    expect(liveSavedGroups(groups, [orders[0], { ...orders[1], on_hold: true }], TODAY)).toEqual(
      [],
    );
  });

  it("keeps a group whose addresses differ only while it is approved", () => {
    const ids = [id(1), id(3)];
    expect(liveSavedGroups([saved(ids)], orders, TODAY)).toEqual([]);
    const ok = [saved(ids, { approved_at: "2026-10-09T10:00:00Z" })];
    expect(liveSavedGroups(ok, orders, TODAY)).toHaveLength(1);
    expect(isApproved(ok, [id(3), id(1)])).toBe(true);
    expect(isApproved(ok, [id(1), id(2)])).toBe(false);
  });

  it("finds the group an order is waiting in, from either order", () => {
    const groups = [saved([id(1), id(2)])];
    expect(knownGroupOf(id(2), groups, orders, TODAY)).toEqual([id(1), id(2)]);
    expect(knownGroupOf(id(1), groups, orders, TODAY)).toEqual([id(1), id(2)]);
    expect(knownGroupOf(id(3), groups, orders, TODAY)).toBeNull();
    // Approved as the same place, never saved: still one group.
    const approved = [saved([id(1), id(3)], { saved_at: null, approved_at: "2026-10-09" })];
    expect(knownGroupOf(id(3), approved, orders, TODAY)).toEqual([id(1), id(3)]);
    // Only waved away: each order is on its own.
    const waved = [saved([id(1), id(2)], { saved_at: null, dismissed_at: "2026-10-09" })];
    expect(knownGroupOf(id(1), waved, orders, TODAY)).toBeNull();
  });
});

describe("a group's page address", () => {
  it("opens on the oldest order with the rest riding along", () => {
    expect(groupHref("/w/a/shipping", [id(1), id(2), id(3)])).toBe(
      `/w/a/shipping/orders/${id(1)}?with=${id(2)},${id(3)}`,
    );
  });

  it("reads back only real ids, once each, never the order itself", () => {
    expect(parseWith(`${id(2)},nope,${id(2)},${id(1)}, ${id(3).toUpperCase()}`, id(1))).toEqual([
      id(2),
      id(3),
    ]);
    expect(parseWith(undefined, id(1))).toEqual([]);
  });
});
