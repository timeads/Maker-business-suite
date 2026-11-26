import { describe, expect, it } from "vitest";
import { DEFAULT_DEBT_SETTINGS, fromOrder, orderOf, parseDebtSettings } from "./settings";

describe("whose order the plan follows", () => {
  it("follows the recommended order until a person chooses", () => {
    expect(DEFAULT_DEBT_SETTINGS.strategy_from).toBe("recommended");
    expect(parseDebtSettings({ version: 1 }).strategy_from).toBe("recommended");
  });

  it("keeps an order chosen before this setting existed, but not the old default", () => {
    expect(parseDebtSettings({ version: 1, strategy: "snowball" })).toMatchObject({
      strategy: "snowball",
      strategy_from: "person",
    });
    expect(parseDebtSettings({ version: 1, strategy: "avalanche" }).strategy_from).toBe(
      "recommended",
    );
    expect(
      parseDebtSettings({ version: 1, strategy: "avalanche", strategy_from: "person" })
        .strategy_from,
    ).toBe("person");
  });

  it("turns the form's one Order box into both fields, and back", () => {
    expect(fromOrder({ order: "recommended", strategy: "custom" })).toEqual({
      strategy: "custom",
      strategy_from: "recommended",
    });
    expect(fromOrder({ order: "hybrid" })).toEqual({ strategy: "hybrid", strategy_from: "person" });
    expect(fromOrder({ revenue_share_pct: 5 })).toEqual({ revenue_share_pct: 5 });
    expect(orderOf(DEFAULT_DEBT_SETTINGS)).toBe("recommended");
    expect(orderOf({ ...DEFAULT_DEBT_SETTINGS, strategy_from: "person", strategy: "custom" })).toBe(
      "custom",
    );
  });
});

describe("the emergency fund's accounts", () => {
  it("reads picks by id or name, and the names typed in earlier", () => {
    const parsed = parseDebtSettings({
      version: 1,
      emergency_picks: [{ id: "35", name: "Rainy Day" }, { name: "Tin Box" }],
      emergency_accounts: ["Old Savings"],
    });
    expect(parsed.emergency_picks).toEqual([
      { id: "35", name: "Rainy Day" },
      { id: null, name: "Tin Box" },
    ]);
    expect(parsed.emergency_accounts).toEqual(["Old Savings"]);
  });
});
