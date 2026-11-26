import { describe, expect, it } from "vitest";
import { applyAction, previewAction } from "./action-proposals";
import { DEBT_TOOLS, MONEY_TOOLS } from "./money-tools";
import { systemFor } from "./run";
import { runTool, toolsFor, type ToolContext } from "./tools";

const DEBTS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Line of credit",
    kind: "line_of_credit",
    plan: "pool",
    status: "active",
    rate_bp: null,
    minimum_cents: 5000,
    payment_cents: null,
    revolving_bp: null,
    due_day: 3,
    priority: null,
    opening_cents: null,
    books_account: "Line of credit",
    note: null,
    source: "books",
    consolidated: false,
    covered_by: null,
    book_account_id: "33333333-3333-4333-8333-333333333333",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Pay plan",
    kind: "other",
    plan: "fixed",
    status: "active",
    rate_bp: 900,
    minimum_cents: 0,
    payment_cents: 40000,
    revolving_bp: null,
    due_day: null,
    priority: null,
    opening_cents: null,
    books_account: null,
    note: null,
    source: "person",
    consolidated: true,
    covered_by: null,
    book_account_id: null,
  },
];
const ACCOUNTS = [
  {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Line of credit",
    account_type: "Other Current Liability",
    account_subtype: "LineOfCredit",
    section: null,
    balance_cents: 120000,
    choice: null,
    hidden_at: null,
  },
];

/** The member's client, answering from fixed rows; records every rpc. */
function fake(rows: Record<string, unknown[]> = {}) {
  const rpcs: { name: string; args: Record<string, unknown> }[] = [];
  const from = (table: string) => {
    let list = rows[table] ?? [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "is", "order", "limit", "in"]) chain[m] = () => chain;
    chain.eq = (column: string, value: unknown) => {
      if (column === "id") list = list.filter((r) => (r as { id: string }).id === value);
      return chain;
    };
    chain.maybeSingle = () => Promise.resolve({ data: list[0] ?? null, error: null });
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: list, error: null });
    return chain;
  };
  const supabase = {
    from,
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return { data: name === "propose_action" ? "proposal-1" : null, error: null };
    },
  };
  return { supabase: supabase as never, rpcs };
}

const ctx = (supabase: ToolContext["supabase"], manager = true): ToolContext => ({
  supabase,
  tenant: { id: "t1", timezone: "America/New_York", currency: "USD", slug: "rugs" },
  can: () => true,
  manager,
});
const both = { money_debts: DEBTS, money_book_accounts: ACCOUNTS };

describe("who is offered the debt tools", () => {
  it("owners and admins only, and the prompt says so only to them", () => {
    const names = (manager: boolean) => toolsFor({ manager }).map((t) => t.name);
    for (const tool of DEBT_TOOLS) {
      expect(names(true)).toContain(tool.name);
      expect(names(false)).not.toContain(tool.name);
    }
    for (const tool of MONEY_TOOLS) expect(names(false)).toContain(tool.name);
    expect(systemFor({ manager: false }, "Rugs")).not.toMatch(/debt/i);
    expect(systemFor({ manager: true }, "Rugs")).toMatch(/list_debts/);
    for (const tool of [...MONEY_TOOLS, ...DEBT_TOOLS]) {
      expect(tool.input_schema.additionalProperties, tool.name).toBe(false);
    }
  });

  it("a plain member's call to a debt tool finds nothing, and reads nothing", async () => {
    const { supabase, rpcs } = fake(both);
    for (const name of ["list_debts", "propose_debt_change", "propose_liability_choice"]) {
      const out = await runTool(name, { debt: "D1", summary: "x" }, ctx(supabase, false));
      expect(out).toEqual({ content: `There is no tool called ${name}.`, isError: true });
    }
    expect(rpcs).toEqual([]);
  });
});

describe("list_debts and proposals", () => {
  it("gives references, never ids", async () => {
    const { supabase } = fake(both);
    const out = await runTool("list_debts", {}, ctx(supabase));
    expect(out.content).not.toContain(DEBTS[0].id);
    const read = JSON.parse(out.content);
    expect(read.debts[0]).toMatchObject({ ref: "D1", name: "Line of credit", rate: "not given" });
    expect(read.liabilities_in_books[0]).toMatchObject({ ref: "L1", counts_as_debt: true });
  });

  it("files 'my line of credit is 10%' as a proposal for the debt's rate, and changes nothing", async () => {
    const { supabase, rpcs } = fake(both);
    const out = await runTool(
      "propose_debt_change",
      { debt: "D1", rate_percent: 10, summary: "Set the line of credit's rate to 10%." },
      ctx(supabase),
    );
    expect(out.isError).toBeUndefined();
    expect(out.proposal).toMatchObject({ id: "proposal-1", source: "action" });
    expect(rpcs).toEqual([
      {
        name: "propose_action",
        args: {
          p_tenant_id: "t1",
          p_kind: "money.debt_details",
          p_target: DEBTS[0].id,
          p_body: { rate_bp: 1000 },
          p_summary: "Set the line of credit's rate to 10%.",
        },
      },
    ]);
  });

  it("refuses what doesn't fit, without filing anything", async () => {
    const { supabase, rpcs } = fake(both);
    const tries = [
      { debt: "D9", rate_percent: 10, summary: "x" },
      { debt: "L1", rate_percent: 10, summary: "x" },
      { debt: "D2", rate_percent: 10, summary: "x" }, // a plan
      { debt: "D1", rate_percent: -3, summary: "x" },
      { debt: "D1", summary: "x" }, // nothing changes
      { debt: "D1", rate_percent: 10, summary: "" },
    ];
    for (const args of tries) {
      expect((await runTool("propose_debt_change", args, ctx(supabase))).isError).toBe(true);
    }
    expect(
      (await runTool("propose_debt_cover", { debt: "D1", plan: "D1", summary: "x" }, ctx(supabase)))
        .isError,
    ).toBe(true);
    expect(rpcs).toEqual([]);
  });

  it("proposes a plan paying a debt, and a liability's choice or hiding", async () => {
    const { supabase, rpcs } = fake(both);
    await runTool("propose_debt_cover", { debt: "D1", plan: "D2", summary: "x" }, ctx(supabase));
    await runTool(
      "propose_liability_choice",
      { account: "L1", choice: "not_debt", summary: "x" },
      ctx(supabase),
    );
    await runTool(
      "propose_liability_choice",
      { account: "L1", choice: "hide", summary: "x" },
      ctx(supabase),
    );
    expect(rpcs.map((r) => [r.args.p_kind, r.args.p_body])).toEqual([
      ["money.debt_cover", { plan_id: DEBTS[1].id }],
      ["money.liability_choice", { choice: "not_debt" }],
      ["money.liability_hide", { hidden: true }],
    ]);
  });
});

describe("previewing and applying", () => {
  const row = {
    id: "p1",
    kind: "money.debt_details",
    target: DEBTS[0].id,
    body: { rate_bp: 1000 },
    summary: "Rate to 10%",
  };

  it("shows before and after from the debt as it is now", async () => {
    const { supabase } = fake(both);
    expect(await previewAction(supabase, { id: "t1", currency: "USD" }, row)).toEqual({
      id: "p1",
      source: "action",
      name: "Debt: Line of credit",
      summary: "Rate to 10%",
      before: ["No rate given"],
      after: ["Rate 10%"],
    });
    // Nothing to show someone who can't read the debt.
    expect(await previewAction(fake().supabase, { id: "t1", currency: "USD" }, row)).toBeNull();
  });

  it("applies through the checked function, keeping every other field", async () => {
    const { supabase, rpcs } = fake(both);
    expect(await applyAction(supabase, "t1", row)).toEqual({});
    expect(rpcs).toEqual([
      {
        name: "save_money_debt",
        args: {
          p_tenant_id: "t1",
          p_debt_id: DEBTS[0].id,
          p_fields: expect.objectContaining({
            name: "Line of credit",
            rate_bp: 1000,
            minimum_cents: 5000,
            due_day: 3,
            books_account: "Line of credit",
          }),
        },
      },
    ]);
    await applyAction(supabase, "t1", {
      kind: "money.liability_choice",
      target: ACCOUNTS[0].id,
      body: { choice: "not_debt" },
    });
    expect(rpcs.at(-1)?.name).toBe("choose_book_liability");
  });

  it("refuses a body that doesn't fit, and a plan", async () => {
    const { supabase, rpcs } = fake(both);
    expect(
      (await applyAction(supabase, "t1", { ...row, body: { name: "Renamed" } })).error,
    ).toBeTruthy();
    expect((await applyAction(supabase, "t1", { ...row, target: DEBTS[1].id })).error).toMatch(
      /plan/,
    );
    expect((await applyAction(supabase, "t1", { ...row, kind: "money.sell" })).error).toBeTruthy();
    expect(rpcs).toEqual([]);
  });
});
