import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const open = vi.fn();
const alert = vi.fn();
vi.mock("../module-access", () => ({ moduleOpen: (...args: unknown[]) => open(...args) }));
vi.mock("../messages/alerts", () => ({ postAlert: (...args: unknown[]) => alert(...args) }));

const { SETUP_NUDGE, nudgeMoneySetup } = await import("./setup-nudge");

const admin = (claimed: boolean | Error) =>
  ({
    rpc: vi.fn(async () =>
      claimed instanceof Error
        ? { data: null, error: { message: claimed.message } }
        : { data: claimed, error: null },
    ),
  }) as unknown as SupabaseClient;

beforeEach(() => {
  open.mockReset();
  alert.mockReset();
});

describe("nudgeMoneySetup", () => {
  it("points at Money → Set up the first time only", async () => {
    open.mockResolvedValue(true);
    expect(await nudgeMoneySetup(admin(true), "t1")).toBe(true);
    expect(alert).toHaveBeenCalledWith(expect.anything(), "t1", "money", SETUP_NUDGE);
    expect(await nudgeMoneySetup(admin(false), "t1")).toBe(false);
    expect(alert).toHaveBeenCalledTimes(1);
  });

  it("says nothing without Money, and never throws", async () => {
    open.mockResolvedValue(false);
    expect(await nudgeMoneySetup(admin(true), "t1")).toBe(false);
    open.mockRejectedValue(new Error("down"));
    expect(await nudgeMoneySetup(admin(true), "t1")).toBe(false);
    open.mockResolvedValue(true);
    expect(await nudgeMoneySetup(admin(new Error("no")), "t1")).toBe(false);
    expect(alert).not.toHaveBeenCalled();
  });
});
