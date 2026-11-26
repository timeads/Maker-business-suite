import { describe, expect, it } from "vitest";
import {
  bookingsHref,
  cleanSearch,
  parseBookingFilters,
  searchFilter,
  sourceOf,
} from "./all-bookings";

const id = "0b0e0f9a-1111-4222-8333-944455556666";

describe("the all-bookings list", () => {
  it("reads its filters from the address, with sensible defaults", () => {
    expect(parseBookingFilters({})).toEqual({
      q: "",
      status: null,
      when: "upcoming",
      source: null,
      service: null,
      page: 1,
    });
    expect(
      parseBookingFilters({
        q: " Pat ",
        status: "cancelled",
        when: "past",
        source: "shop",
        service: id.toUpperCase(),
        page: "3",
      }),
    ).toEqual({
      q: "Pat",
      status: "cancelled",
      when: "past",
      source: "shop",
      service: id,
      page: 3,
    });
    expect(
      parseBookingFilters({ status: "x", when: "y", source: "z", service: "1", page: "-2" }),
    ).toMatchObject({ status: null, when: "upcoming", source: null, service: null, page: 1 });
  });

  it("keeps a search to the letters a name, email or order number holds", () => {
    expect(cleanSearch("pat@example.com")).toBe("pat@example.com");
    expect(cleanSearch("#1042")).toBe("#1042");
    expect(cleanSearch("a,b),c.ilike.%x%")).toBe("a b c.ilike. x");
    expect(cleanSearch("José O'Neil")).toBe("José O'Neil");
    expect(searchFilter("")).toBeNull();
    expect(searchFilter("50%_off")).toBe(
      "customer_name.ilike.%50 off%,customer_email.ilike.%50 off%,shop_order_name.ilike.%50 off%",
    );
  });

  it("writes the address back, dropping defaults and starting a new filter at page 1", () => {
    const filters = parseBookingFilters({ q: "pat", page: "4" });
    expect(bookingsHref("/w/a/bookings/all", filters, { status: "confirmed" })).toBe(
      "/w/a/bookings/all?q=pat&status=confirmed",
    );
    expect(bookingsHref("/w/a/bookings/all", filters, { page: 5 })).toBe(
      "/w/a/bookings/all?q=pat&page=5",
    );
    expect(bookingsHref("/w/a/bookings/all", parseBookingFilters({}), { when: "any" })).toBe(
      "/w/a/bookings/all?when=any",
    );
  });

  it("says where a booking came from", () => {
    expect(sourceOf({ source: "online", shop_order_id: "123" })).toBe("shop");
    expect(sourceOf({ source: "online", shop_order_id: null })).toBe("online");
    expect(sourceOf({ source: "manual", shop_order_id: null })).toBe("manual");
  });
});
