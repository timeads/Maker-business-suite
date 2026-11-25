import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOT_FOUND_HEADERS,
  NOT_FOUND_PAGE,
  helpCentreGate,
  helpCentreRoute,
} from "./help-centre-gate";

const TENANT = "11111111-1111-4111-8111-111111111111";

/** A stand-in for the service client: one function answer, and a plan. */
function fakeAdmin(where: unknown, subscription: unknown, calls: string[] = []) {
  const table = (name: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({
        data: name === "subscriptions" ? subscription : null,
        error: null,
      }),
    };
    return chain;
  };
  return {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`${fn}:${args.p_workspace}:${args.p_article}`);
      return { data: where, error: null };
    },
    from: table,
  } as unknown as SupabaseClient;
}

const active = {
  tenant_id: TENANT,
  plan: "growth",
  status: "active",
  trial_end: null,
  current_period_end: "2999-01-01T00:00:00Z",
  cancel_at_period_end: false,
  ended_at: null,
  purge_after: null,
  selected_modules: [],
};

describe("which addresses are a help centre page", () => {
  it("a workspace's home and one article, and nothing else", () => {
    expect(helpCentreRoute("/help-centre/wild-thread")).toEqual({
      workspace: "wild-thread",
      article: null,
    });
    expect(helpCentreRoute("/help-centre/wild-thread/")).toEqual({
      workspace: "wild-thread",
      article: null,
    });
    expect(helpCentreRoute("/help-centre/wild-thread/care")).toEqual({
      workspace: "wild-thread",
      article: "care",
    });
    for (const path of [
      "/help-centre",
      "/help-centre/",
      "/help-centre/a/b/c",
      "/help-centre/wild-thread/sitemap.xml",
      "/help/wild-thread",
      "/w/wild-thread/helpdesk",
    ]) {
      expect(helpCentreRoute(path), path).toBeNull();
    }
  });
});

describe("the check in front of a public page", () => {
  beforeEach(() => {
    vi.stubEnv("SUPABASE_SECRET_KEY", "test-only-placeholder");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:1");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("lets a page through only when the database says it is there and the plan has the help desk", async () => {
    const here = { tenant_id: TENANT, slug: "care" };
    expect(await helpCentreGate("wild-thread", "care", fakeAdmin(here, active))).toEqual({
      kind: "ok",
    });
    expect(
      await helpCentreGate(
        "wild-thread",
        null,
        fakeAdmin({ tenant_id: TENANT, slug: null }, active),
      ),
    ).toEqual({ kind: "ok" });
    expect(await helpCentreGate("wild-thread", "care", fakeAdmin(null, active))).toEqual({
      kind: "missing",
    });
    // The plan has ended, or never had the help desk: the same answer as "no such page".
    expect(
      await helpCentreGate(
        "wild-thread",
        "care",
        fakeAdmin(here, { ...active, status: "canceled", ended_at: "2020-01-01T00:00:00Z" }),
      ),
    ).toEqual({ kind: "missing" });
    expect(await helpCentreGate("wild-thread", "care", fakeAdmin(here, null))).toEqual({
      kind: "missing",
    });
  });

  it("sends an old address on to the one the article has now", async () => {
    expect(
      await helpCentreGate(
        "wild-thread",
        "old-care",
        fakeAdmin({ tenant_id: TENANT, slug: "care" }, active),
      ),
    ).toEqual({ kind: "moved", slug: "care" });
  });

  it("never asks the database about an address that couldn't be one", async () => {
    const calls: string[] = [];
    const admin = fakeAdmin({ tenant_id: TENANT, slug: "x" }, active, calls);
    for (const [workspace, article] of [
      ["Wild Thread", null],
      ["wild-thread", "a b"],
      ["wild-thread", "../secret"],
      ["wild_thread", "x"],
      ["w".repeat(81), null],
    ] as const) {
      expect(await helpCentreGate(workspace, article, admin)).toEqual({ kind: "missing" });
    }
    expect(calls).toEqual([]);
  });

  it("shows nothing when it can't tell, or isn't set up", async () => {
    const broken = {
      rpc: async () => {
        throw new Error("down");
      },
    } as unknown as SupabaseClient;
    expect(await helpCentreGate("wild-thread", null, broken)).toEqual({ kind: "missing" });
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(
      await helpCentreGate(
        "wild-thread",
        null,
        fakeAdmin({ tenant_id: TENANT, slug: null }, active),
      ),
    ).toEqual({ kind: "missing" });
  });

  it("answers 'not found' with a page that loads nothing and names nobody", () => {
    expect(NOT_FOUND_PAGE).not.toMatch(/<script|<link|<img|src=|href=/);
    expect(NOT_FOUND_HEADERS["content-security-policy"]).toContain("default-src 'none'");
    expect(NOT_FOUND_HEADERS["x-robots-tag"]).toBe("noindex");
  });
});
