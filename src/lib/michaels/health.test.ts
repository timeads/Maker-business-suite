import { describe, expect, it } from "vitest";
import { syncHealth } from "./health";

const now = new Date("2026-10-21T14:00:00Z");
const ago = (min: number) => new Date(now.getTime() - min * 60_000);

describe("syncHealth", () => {
  it("is ok within three hours of a look that worked", () => {
    const fresh = { enabled: true, lastSuccessAt: ago(50), lastRunAt: ago(2), lastError: null };
    expect(syncHealth(fresh, now).level).toBe("ok");
    expect(syncHealth({ ...fresh, lastSuccessAt: ago(180) }, now).level).toBe("ok");
  });

  it("is stale past that: the worker stopped, or every look is failing", () => {
    expect(
      syncHealth(
        { enabled: true, lastSuccessAt: ago(181), lastRunAt: ago(181), lastError: null },
        now,
      ).level,
    ).toBe("stale");
    const failing = syncHealth(
      { enabled: true, lastSuccessAt: ago(400), lastRunAt: ago(3), lastError: "orders: boom" },
      now,
    );
    expect(failing).toMatchObject({ level: "stale", lastError: "orders: boom" });
  });

  it("is never when switched on but no look has worked, and off when switched off", () => {
    expect(
      syncHealth({ enabled: true, lastSuccessAt: null, lastRunAt: null, lastError: null }, now)
        .level,
    ).toBe("never");
    expect(
      syncHealth(
        { enabled: false, lastSuccessAt: ago(500), lastRunAt: ago(500), lastError: null },
        now,
      ).level,
    ).toBe("off");
  });

  it("takes another threshold", () => {
    const input = { enabled: true, lastSuccessAt: ago(31), lastRunAt: ago(31), lastError: null };
    expect(syncHealth(input, now, 30 * 60_000).level).toBe("stale");
  });
});
