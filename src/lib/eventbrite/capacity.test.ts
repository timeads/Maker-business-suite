import { describe, expect, it } from "vitest";
import { planTicketClass } from "./capacity";

const tc = (quantityTotal: number, quantitySold: number, hidden = false) => ({
  id: "77",
  name: "General",
  quantityTotal,
  quantitySold,
  hidden,
});

// The earlier app's reconcileTicketClass, as arithmetic.
describe("places pushed to an Eventbrite ticket type", () => {
  it("lets Eventbrite sell exactly the places left here", () => {
    expect(planTicketClass(tc(10, 3), 4)).toMatchObject({
      change: { quantity_total: 7 },
      total: 7,
      hidden: false,
      words: "4 places on sale",
    });
    expect(planTicketClass(tc(7, 3), 4).change).toBeNull();
    expect(planTicketClass(tc(7, 3), 1).words).toBe("1 place on sale");
  });

  it("shows sold out when full and Eventbrite has sold some", () => {
    expect(planTicketClass(tc(10, 3), 0)).toMatchObject({
      change: { quantity_total: 3 },
      total: 3,
      words: "Sold out on Eventbrite",
    });
    expect(planTicketClass(tc(3, 3), 0).change).toBeNull();
    // Never below nothing, however the sums come out.
    expect(planTicketClass(tc(3, 3), -2).change).toBeNull();
  });

  it("hides the ticket when full and Eventbrite sold none (it won't take 0)", () => {
    expect(planTicketClass(tc(10, 0), 0)).toMatchObject({ change: { hidden: true }, hidden: true });
    expect(planTicketClass(tc(10, 0, true), 0).change).toBeNull();
  });

  it("shows a hidden ticket again when places free up", () => {
    expect(planTicketClass(tc(10, 0, true), 2).change).toEqual({
      quantity_total: 2,
      hidden: false,
    });
    expect(planTicketClass(tc(2, 0, true), 2).change).toEqual({ hidden: false });
  });
});
