import { describe, expect, it } from "vitest";
import { keyAlert, runAlerts } from "./alerts";
import { keyExpiry } from "./mapping";

const base = {
  key: keyExpiry("2026-09-01", "2026-09-05"),
  keyRejected: false,
  connectionId: "conn-1",
  blocked: false,
  unmatched: 0,
  skus: 40,
  failedInRow: 0,
  error: null,
  month: "2026-09",
};

describe("keyAlert", () => {
  it("says nothing while the key is young or its date isn't known", () => {
    expect(keyAlert(keyExpiry("2026-09-01", "2026-09-05"))).toBeNull();
    expect(keyAlert(keyExpiry(undefined, "2026-09-05"))).toBeNull();
  });

  it("speaks once as each band is entered", () => {
    const at = (today: string) => keyAlert(keyExpiry("2026-09-01", today))?.key;
    expect(at("2026-10-17")).toBe("replace:2026-10-31:14");
    expect(at("2026-10-20")).toBe("replace:2026-10-31:14");
    expect(at("2026-10-24")).toBe("replace:2026-10-31:7");
    expect(at("2026-10-28")).toBe("replace:2026-10-31:3");
    expect(at("2026-10-30")).toBe("replace:2026-10-31:1");
    expect(at("2026-10-31")).toBe("replace:2026-10-31:due");
    expect(at("2026-11-30")).toBe("key:2026-11-30:expired");
  });
});

describe("runAlerts", () => {
  it("is quiet when all is well", () => {
    expect(runAlerts(base)).toEqual([]);
  });

  it("mentions a rejected key, the safety stop and a third failure in a row", () => {
    const alerts = runAlerts({
      ...base,
      keyRejected: true,
      blocked: true,
      unmatched: 6,
      failedInRow: 3,
      error: "listings: boom",
    });
    expect(alerts.map((a) => a.key)).toEqual([
      "rejected:conn-1:2026-09",
      "unmatched:2026-09",
      "failing:2026-09:listings: boom",
    ]);
    expect(alerts[1]!.text).toContain("6 of your 40");
  });

  it("mentions failures at the third in a row only", () => {
    expect(runAlerts({ ...base, failedInRow: 2 })).toEqual([]);
    expect(runAlerts({ ...base, failedInRow: 4 })).toEqual([]);
  });
});
