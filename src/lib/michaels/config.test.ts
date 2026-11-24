import { describe, expect, it } from "vitest";
import { DEFAULT_MICHAELS_SETTINGS, michaelsSettingsSchema, parseMichaelsSettings } from "./config";

describe("Michaels settings", () => {
  it("starts switched off, watching only, holding one unit back", () => {
    expect(DEFAULT_MICHAELS_SETTINGS).toEqual({
      version: 1,
      enabled: false,
      mode: "watch",
      units_held_back: 1,
      jobs: { stock: true, prices: true, orders: true },
    });
  });

  it("offers no mode but watching", () => {
    for (const mode of ["live", "send", "shadow", "", null, true]) {
      expect(michaelsSettingsSchema.safeParse({ version: 1, enabled: true, mode }).success).toBe(
        false,
      );
    }
    // A stored body that asks for more reads as switched off.
    expect(parseMichaelsSettings({ version: 1, enabled: true, mode: "live" })).toEqual(
      DEFAULT_MICHAELS_SETTINGS,
    );
  });

  it("has nowhere to keep a go-live switch or a cut-over time", () => {
    const parsed = parseMichaelsSettings({
      version: 1,
      enabled: true,
      go_live: true,
      cutover_at: "2026-01-01T00:00:00Z",
      jobs: { stock: false, send_stock: true },
    });
    expect(parsed).toEqual({
      version: 1,
      enabled: true,
      mode: "watch",
      units_held_back: 1,
      jobs: { stock: false, prices: true, orders: true },
    });
  });

  it("keeps the units held back within reason", () => {
    const held = (n: unknown) =>
      michaelsSettingsSchema.safeParse({ version: 1, units_held_back: n }).success;
    expect(held(0)).toBe(true);
    expect(held(1000)).toBe(true);
    expect(held(-1)).toBe(false);
    expect(held(1.5)).toBe(false);
    expect(held(1001)).toBe(false);
  });
});
