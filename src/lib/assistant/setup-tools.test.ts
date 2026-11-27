import { describe, expect, it } from "vitest";
import { SETUP_TOOLS } from "./setup-tools";
import { runTool, toolsFor, type ToolContext } from "./tools";

/**
 * A member's database session that answers every query with nothing (or
 * the rows given per table): enough for the setup tools to work out their
 * items without a database.
 */
function fake(rows: Record<string, unknown[]> = {}) {
  const chain = (table: string): unknown => {
    const result = { data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length };
    const self: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      maybeSingle: () => Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, error: null }),
    };
    return new Proxy(self, {
      get: (target, key: string) => (key in target ? target[key] : () => chain(table)),
    });
  };
  return { from: (table: string) => chain(table), rpc: (name: string) => chain(`rpc:${name}`) };
}

const ctx = (has: string[], manager = false): ToolContext => ({
  supabase: fake() as never,
  tenant: { id: "t1", timezone: "America/New_York", currency: "USD", slug: "rugs" },
  can: (module) => has.includes(module),
  onPlan: () => true,
  manager,
});
const names = (c: Pick<ToolContext, "manager" | "can" | "onPlan">) =>
  toolsFor(c).map((tool) => tool.name);

describe("who is offered the setup tools", () => {
  it("offers each tool's status only to people who can open that tool", () => {
    expect(names(ctx(["stock"]))).toContain("stock_setup_status");
    expect(names(ctx(["stock"]))).not.toContain("shipping_setup_status");
    expect(names(ctx(["shipping"]))).toEqual(expect.arrayContaining(["shipping_setup_status"]));
    expect(names(ctx(["shipping"]))).not.toContain("stock_setup_status");
    expect(names(ctx(["helpdesk"]))).not.toContain("stock_setup_status");
    expect(names(ctx(["stock", "shipping"], true))).toEqual(
      expect.arrayContaining(["stock_setup_status", "shipping_setup_status"]),
    );
  });

  it("sends the model only a tool's name, words and schema", () => {
    for (const tool of SETUP_TOOLS) {
      expect(Object.keys(tool).sort()).toEqual(["description", "input_schema", "name"]);
    }
  });

  it("refuses a tool the person can't open, as if it didn't exist", async () => {
    const out = await runTool("shipping_setup_status", {}, ctx(["stock"]));
    expect(out).toMatchObject({
      isError: true,
      content: "There is no tool called shipping_setup_status.",
    });
  });
});

describe("what the setup tools answer", () => {
  it("Stock: the open items with where they're done, and who can do them", async () => {
    const out = await runTool("stock_setup_status", {}, ctx(["stock"]));
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content) as {
      open: { what: string; where: string; owners_and_admins_only: boolean; optional: boolean }[];
      guided_setup: string;
      note?: string;
    };
    expect(body.open[0]).toMatchObject({
      what: "Connect your shop",
      where: "/w/rugs/connections",
      owners_and_admins_only: true,
      optional: false,
    });
    expect(body.guided_setup).toBe("/w/rugs/stock/setup");
    expect(body.note).toMatch(/ask one/);
  });

  it("Shipping: the same, from its own facts", async () => {
    const out = await runTool("shipping_setup_status", {}, ctx(["shipping"], true));
    const body = JSON.parse(out.content) as {
      open: { what: string; optional: boolean }[];
      guided_setup: string;
      note?: string;
    };
    const what = body.open.map((item) => item.what);
    expect(what).toEqual(
      expect.arrayContaining([
        "Connect your shop",
        "Finish your ship-from address",
        "Add the boxes you pack in",
      ]),
    );
    expect(body.open.find((item) => item.what.startsWith("Connect a postage"))?.optional).toBe(
      true,
    );
    expect(body.guided_setup).toBe("/w/rugs/shipping/setup");
    expect(body.note).toBeUndefined();
  });
});
