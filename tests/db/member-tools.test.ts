import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER_TOOLS, toolAllowed, type TeamRole } from "../../src/lib/team/tools";
import { asService, asUser, createTestDb, createUser } from "./harness";

/**
 * Tools per person (docs/roles.md), held in the database:
 *  - one predicate, `private.tool_allowed`, equal to its TypeScript twin;
 *  - while a workspace's switch is off, nothing changes for anyone;
 *  - once it is on, a member reads and writes only their own tools, and
 *    never Money; owners and admins are untouched;
 *  - only owners and admins choose, never for themselves or each other;
 *  - an invite's ticks are applied when it is accepted, and an invite with
 *    none gives none.
 */

type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let dan: User; // admin of A
let carol: User; // member of A from before the switch
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;

const ALL_TOOLS = ["messages", "dashboard", ...MEMBER_TOOLS] as const;

/** Every Money table: each must read empty for a member once the switch is on. */
const MONEY_TABLES = [
  "financial_snapshots",
  "book_expenses",
  "book_invoices",
  "money_book_accounts",
  "money_budgets",
  "money_charge_decisions",
  "money_line_entries",
  "money_debt_imports",
  "money_debts",
  "money_debt_balances",
  "money_debt_plan_months",
  "money_debt_scenarios",
  "action_proposals",
];

/** Every Money reading function, called with arguments that cover all of A's rows. */
const MONEY_FUNCTIONS: [string, unknown[]][] = [
  ["dashboard_sales_by_channel(p_tenant_id => $1, p_from => $2, p_to => $3)", ["FROM", "TO"]],
  [
    "dashboard_sales_by_period(p_tenant_id => $1, p_from => $2, p_to => $3, p_grouping => 'month', p_timezone => 'America/New_York')",
    ["FROM", "TO"],
  ],
  ["dashboard_top_products(p_tenant_id => $1, p_from => $2, p_to => $3)", ["FROM", "TO"]],
  ["money_account_totals($1, $2::date, $3::date)", ["FROM", "TO"]],
  ["money_debt_current($1)", []],
  ["money_debt_payment_list($1, 50)", []],
  ["money_debt_payments($1, $2::date, $3::date)", ["FROM", "TO"]],
  ["money_expense_accounts($1, $2::date)", ["FROM"]],
  ["money_expense_months($1)", []],
  ["money_expense_totals($1, $2::date, $3::date, 'month')", ["FROM", "TO"]],
  ["money_invoice_accounts($1, $2::date)", ["FROM"]],
  ["money_invoice_counts($1, '2026-11-27')", []],
  ["money_invoice_list($1, '2026-11-27', null, null, null, null, 50, 0)", []],
  ["money_invoice_revenue($1, $2::date, $3::date, 'month')", ["FROM", "TO"]],
  ["money_line_item_costs($1, $2, $3)", ["FROM", "TO"]],
  [
    "money_line_revenue($1, $2, $3, 'month', 'America/New_York', 'net_sales', false, false)",
    ["FROM", "TO"],
  ],
  ["money_move_accounts($1)", []],
  ["money_order_list($1, $2, $3, null, null, 50, 0)", ["FROM", "TO"]],
  ["money_recent_order_lines($1, $2)", ["FROM"]],
  ["money_sales_by_channel($1, $2, $3, 'net_sales')", ["FROM", "TO"]],
  ["money_sales_by_period($1, $2, $3, 'month', 'America/New_York', 'net_sales')", ["FROM", "TO"]],
  ["money_shipping_by_month($1, $2, $3, 'America/New_York')", ["FROM", "TO"]],
];
const RANGE: Record<string, string> = { FROM: "2020-01-01", TO: "2030-01-01" };

const as = <T = Record<string, unknown>>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const service = (sql: string, params: unknown[] = []) =>
  asService(db, async (tx) => (await tx.query(sql, params)).rows);

const count = async (user: User, table: string, tenant = tenantA) =>
  Number(
    (
      await as<{ n: string }>(
        user,
        `select count(*) as n from public.${table} where tenant_id = $1`,
        [tenant],
      )
    )[0].n,
  );
const canUse = async (user: User, tool: string, tenant = tenantA) =>
  (await as<{ ok: boolean }>(user, "select private.can_use_tool($1, $2) as ok", [tenant, tool]))[0]
    .ok;
const moneyRows = async (user: User, call: string, params: unknown[]) =>
  (
    await as(user, `select * from public.${call}`, [
      tenantA,
      ...params.map((p) => RANGE[p as string] ?? p),
    ])
  ).length;

async function tenantFor(owner: User, name: string): Promise<string> {
  return asUser(db, owner, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "select id from public.create_tenant($1, 'America/New_York', 'USD')",
      [name],
    );
    return rows[0].id;
  });
}

async function join(tenant: string, user: User, role: TeamRole) {
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, $3::public.membership_role)",
    [tenant, user.id, role],
  );
}

const switchTo = (user: User, on: boolean, tools: string[] = [...MEMBER_TOOLS], tenant = tenantA) =>
  as(user, "select public.set_tools_per_person($1, $2, $3::text[])", [tenant, on, tools]);
const setTools = (by: User, who: User, tools: string[], tenant = tenantA) =>
  as<{ tools: string[] }>(by, "select public.set_member_tools($1, $2, $3::text[]) as tools", [
    tenant,
    who.id,
    tools,
  ]);
const toolsOf = async (user: User, tenant = tenantA) =>
  (
    await db.query<{ tools: string[] }>(
      "select tools from public.member_tools where tenant_id = $1 and user_id = $2",
      [tenant, user.id],
    )
  ).rows[0]?.tools ?? null;

async function inviteAndJoin(email: string, role: TeamRole, tools: string[] | null): Promise<User> {
  const person = { id: await createUser(db, email), email };
  const [{ token }] = await as<{ token: string }>(
    alice,
    "select * from public.create_team_invite($1, $2, $3::public.membership_role, $4::text[])",
    [tenantA, email, role, tools],
  );
  await as(person, "select public.accept_invite($1)", [token]);
  return person;
}

/** A line of an order placed with the supplier, waiting on its delivery. */
async function orderedLine(): Promise<string> {
  const item = (
    await db.query<{ id: string }>("select id from public.stock_items where tenant_id = $1", [
      tenantA,
    ])
  ).rows[0].id;
  const supplier = (
    await db.query<{ id: string }>("select id from public.suppliers where tenant_id = $1", [
      tenantA,
    ])
  ).rows[0].id;
  await as(alice, "select public.create_purchase_order($1, $2, $3::jsonb, '')", [
    tenantA,
    supplier,
    JSON.stringify([{ stock_item_id: item, qty: 5, unit_cost: 60 }]),
  ]);
  const order = (
    await db.query<{ id: string }>(
      "select id from public.purchase_orders where tenant_id = $1 order by created_at desc limit 1",
      [tenantA],
    )
  ).rows[0].id;
  await as(alice, "select public.set_purchase_order_status($1, 'ordered')", [order]);
  return (
    await db.query<{ id: string }>("select id from public.purchase_order_lines where po_id = $1", [
      order,
    ])
  ).rows[0].id;
}

async function seedA() {
  // The shop's orders, which Money's figures are worked out from.
  await service(
    "select public.upsert_commerce_batch($1, 'shopify', '[]'::jsonb, '[]'::jsonb, $2::jsonb)",
    [
      tenantA,
      JSON.stringify([
        {
          external_id: "o-1",
          name: "#1",
          processed_at: "2026-10-03T15:00:00Z",
          currency: "USD",
          net_sales: 120,
          total: 130,
          channel: "Online Store",
          lines: [
            {
              external_id: "l-1",
              title: "Wool rug",
              quantity: 1,
              unit_price: 120,
              unit_cost: 50,
              product_external_id: "p-1",
            },
          ],
        },
      ]),
    ],
  );
  await service("select public.save_financial_snapshots($1, 'quickbooks', $2::jsonb)", [
    tenantA,
    JSON.stringify([
      { kind: "balance_sheet", period_start: "2026-10-31", period_end: "2026-10-31", data: {} },
    ]),
  ]);
  await service("select public.file_book_expenses($1, 'quickbooks', $2, $3::jsonb)", [
    tenantA,
    "11111111-1111-4111-8111-111111111111",
    JSON.stringify([
      {
        entity: "Purchase",
        external_id: "e-1",
        kind: "purchase",
        date: "2026-10-05",
        amount_cents: 4599,
        account: "Supplies",
        payee: "A yarn shop",
        memo: "",
        lines: [],
      },
    ]),
  ]);
  await as(alice, "select public.save_config($1, 'dashboard', 'main', '{\"name\":\"A\"}')", [
    tenantA,
  ]);
  await as(alice, "select public.propose_action($1, 'money.budget', null, $2::jsonb, 'Budget')", [
    tenantA,
    JSON.stringify({ month: "2026-11-01", rows: [] }),
  ]);
  // One row in each other tool.
  await service("select public.upsert_stock_items($1, 'shopify', $2::jsonb)", [
    tenantA,
    JSON.stringify([
      {
        external_id: "v-1",
        product_external_id: "p-1",
        inventory_item_id: "i-1",
        title: "Wool rug",
        variant_title: null,
        sku: "RUG-1",
        on_hand: 4,
        unit_cost: 50,
        tracked: true,
        product_status: "ACTIVE",
      },
    ]),
  ]);
  await as(alice, "select public.start_ticket($1, 'shopper@example.test', null, 'Where is it?')", [
    tenantA,
  ]);
  await as(alice, "select public.save_social_post($1, null, 'New rugs', null, $2, null)", [
    tenantA,
    ["facebook"],
  ]);
  await as(
    alice,
    "select public.save_service($1, null, 'workshop', 'Tufting 101', '', 60, 50, 6, true)",
    [tenantA],
  );
  await as(
    alice,
    "select public.save_supplier($1, null, 'A mill', 'orders@mill.test', 21, 45, 10, 'order', '')",
    [tenantA],
  );
}

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@a.test"), email: "alice@a.test" };
  dan = { id: await createUser(db, "dan@a.test"), email: "dan@a.test" };
  carol = { id: await createUser(db, "carol@a.test"), email: "carol@a.test" };
  bob = { id: await createUser(db, "bob@b.test"), email: "bob@b.test" };
  tenantA = await tenantFor(alice, "Alice Rugs");
  tenantB = await tenantFor(bob, "Bob Pottery");
  await join(tenantA, dan, "admin");
  await join(tenantA, carol, "member");
  await seedA();
});

describe("the predicate", () => {
  it("matches its TypeScript twin for every role, switch, list and tool", async () => {
    const lists: (string[] | null)[] = [
      null,
      [],
      ["helpdesk"],
      ["stock", "shipping"],
      [...MEMBER_TOOLS],
    ];
    let checked = 0;
    for (const role of ["owner", "admin", "member"] as TeamRole[]) {
      for (const on of [false, true]) {
        for (const tools of lists) {
          for (const tool of ALL_TOOLS) {
            const { rows } = await db.query<{ ok: boolean }>(
              "select private.tool_allowed($1::public.membership_role, $2, $3::text[], $4) as ok",
              [role, on, tools, tool],
            );
            expect(rows[0].ok, `${role} on=${on} ${JSON.stringify(tools)} ${tool}`).toBe(
              toolAllowed({ role, on, tools }, tool),
            );
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(3 * 2 * 5 * ALL_TOOLS.length);
    // Somebody who isn't on the team has nothing, on either side.
    const { rows } = await db.query<{ ok: boolean }>(
      "select private.tool_allowed(null, false, null, 'messages') as ok",
    );
    expect(rows[0].ok).toBe(false);
    expect(toolAllowed(null, "messages")).toBe(false);
  });

  it("is off for every workspace to begin with, new or old", async () => {
    const { rows } = await db.query<{ on: boolean }>(
      "select tools_per_person as on from public.tenants",
    );
    expect(rows.length).toBe(2);
    expect(rows.every((row) => row.on === false)).toBe(true);
  });
});

describe("while the switch is off", () => {
  it("a member opens every tool, Money included, exactly as before", async () => {
    for (const tool of ALL_TOOLS) expect(await canUse(carol, tool)).toBe(true);
    for (const table of [...MONEY_TABLES, "stock_items", "tickets", "social_posts", "services"]) {
      expect(await count(carol, table), table).toBe(await count(alice, table));
    }
    for (const [call, params] of MONEY_FUNCTIONS) {
      expect(await moneyRows(carol, call, params), call).toBe(await moneyRows(alice, call, params));
    }
    expect(await count(carol, "financial_snapshots")).toBe(1);
    expect(
      await moneyRows(carol, "money_sales_by_channel($1, $2, $3, 'net_sales')", ["FROM", "TO"]),
    ).toBe(1);
    expect(
      (await as<{ ok: boolean }>(carol, "select private.can_see_costs($1) as ok", [tenantA]))[0].ok,
    ).toBe(true);
  });

  it("a member's writes work as before", async () => {
    await as(carol, "select public.save_social_post($1, null, 'Before', null, $2, null)", [
      tenantA,
      ["facebook"],
    ]);
    expect(await count(carol, "social_posts")).toBe(2);
  });
});

describe("who may choose", () => {
  it("a member can't switch it on, or choose anyone's tools, their own included", async () => {
    await expect(switchTo(carol, true)).rejects.toMatchObject({ code: "42501" });
    await expect(setTools(carol, carol, ["stock"])).rejects.toMatchObject({ code: "42501" });
    await expect(setTools(carol, dan, ["stock"])).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(carol, "insert into public.member_tools (tenant_id, user_id) values ($1, $2)", [
        tenantA,
        carol.id,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await toolsOf(carol)).toBeNull();
  });

  it("owners and admins always have everything: their own list can't be set", async () => {
    await expect(setTools(alice, alice, ["stock"])).rejects.toMatchObject({ code: "42501" });
    await expect(setTools(alice, dan, ["stock"])).rejects.toMatchObject({ code: "22023" });
    await expect(setTools(dan, alice, ["stock"])).rejects.toMatchObject({ code: "22023" });
  });

  it("Money and unknown tools can't be ticked", async () => {
    await expect(setTools(alice, carol, ["dashboard"])).rejects.toMatchObject({ code: "22023" });
    await expect(setTools(alice, carol, ["payroll"])).rejects.toMatchObject({ code: "22023" });
    await expect(
      as(alice, "select * from public.create_team_invite($1, 'x@a.test', 'member', $2::text[])", [
        tenantA,
        ["dashboard"],
      ]),
    ).rejects.toMatchObject({ code: "22023" });
  });

  it("nobody reaches across workspaces", async () => {
    await expect(switchTo(bob, true, [], tenantA)).rejects.toMatchObject({ code: "42501" });
    await expect(setTools(bob, carol, ["stock"], tenantA)).rejects.toMatchObject({ code: "42501" });
    for (const tool of ALL_TOOLS) expect(await canUse(bob, tool, tenantA)).toBe(false);
    expect(await as(bob, "select * from public.my_tool_access($1)", [tenantA])).toEqual([]);
  });
});

describe("switching it on", () => {
  it("gives the team they have now the plan's tools, never Money, and is written down", async () => {
    await switchTo(alice, true);
    expect(await toolsOf(carol)).toEqual([...MEMBER_TOOLS]);
    expect(await toolsOf(alice)).toBeNull();
    expect(await toolsOf(dan)).toBeNull();
    const audit = await db.query<{ metadata: { on: boolean; given_tools: number } }>(
      "select metadata from public.audit_log where tenant_id = $1 and action = 'team.tools_per_person'",
      [tenantA],
    );
    expect(audit.rows.map((row) => row.metadata)).toMatchObject([{ on: true, given_tools: 1 }]);
    expect(
      await as(carol, "select role, tools_on, tools from public.my_tool_access($1)", [tenantA]),
    ).toEqual([{ role: "member", tools_on: true, tools: [...MEMBER_TOOLS] }]);
    // Tenant B is untouched.
    const { rows } = await db.query<{ on: boolean }>(
      "select tools_per_person as on from public.tenants where id = $1",
      [tenantB],
    );
    expect(rows[0].on).toBe(false);
  });

  it("hides every Money table and figure from a member, and from nobody else", async () => {
    expect(await canUse(carol, "dashboard")).toBe(false);
    for (const table of MONEY_TABLES) expect(await count(carol, table), table).toBe(0);
    for (const [call, params] of MONEY_FUNCTIONS) {
      expect(await moneyRows(carol, call, params), call).toBe(0);
    }
    const dashboardConfigs = (user: User) =>
      as(user, "select key from public.configs where tenant_id = $1 and module = 'dashboard'", [
        tenantA,
      ]);
    expect(await dashboardConfigs(carol)).toEqual([]);
    expect(
      await as(carol, "select id from public.config_versions where module = 'dashboard'"),
    ).toEqual([]);
    // The figures are still there for the owner and the admin.
    for (const user of [alice, dan]) {
      expect(await count(user, "financial_snapshots")).toBe(1);
      expect(await count(user, "book_expenses")).toBe(1);
      expect(await count(user, "action_proposals")).toBe(1);
      expect(await dashboardConfigs(user)).toHaveLength(1);
      expect(
        await moneyRows(user, "money_sales_by_channel($1, $2, $3, 'net_sales')", ["FROM", "TO"]),
      ).toBe(1);
      expect(
        await moneyRows(user, "money_order_list($1, $2, $3, null, null, 50, 0)", ["FROM", "TO"]),
      ).toBe(1);
    }
    // The shop's own orders stay the whole team's.
    expect(await count(carol, "orders")).toBe(1);
  });

  it("every Money table and every tool table is held for reading by a restrictive policy", async () => {
    const { rows } = await db.query<{ table: string; held: boolean }>(`
      select c.relname as "table",
             exists (select 1 from pg_policies p
                     where p.schemaname = 'public' and p.tablename = c.relname
                       and p.permissive = 'RESTRICTIVE' and p.cmd = 'SELECT') as held
      from pg_trigger tg join pg_class c on c.oid = tg.tgrelid
      where tg.tgname = 'tool_write_guard'`);
    expect(rows.length).toBeGreaterThan(100);
    for (const row of rows) expect(row.held, row.table).toBe(true);
    for (const table of MONEY_TABLES) {
      expect(
        rows.some((row) => row.table === table),
        table,
      ).toBe(true);
    }
  });

  it("leaves no table unheld but the workspace's own and the shop's records", async () => {
    // A new table belongs to a tool (and gets its policy and guard) or is
    // added here on purpose.
    const SHARED = [
      "audit_log",
      "brands",
      "chat_channels",
      "chat_members",
      "chat_messages",
      "chat_reads",
      "connections",
      "customers",
      "invites",
      "member_tools",
      "memberships",
      "order_lines",
      "orders",
      "plan_grants",
      "products",
      "setup_not_now",
      "subscriptions",
      "sync_jobs",
      "tenants",
      "usage_events",
    ];
    const { rows } = await db.query<{ t: string }>(`
      select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r'
        and not exists (select 1 from pg_trigger tg
                        where tg.tgrelid = c.oid and tg.tgname = 'tool_write_guard')
      order by 1`);
    expect(rows.map((row) => row.t)).toEqual(SHARED);
  });

  it("refuses a member's Money writes, whatever function they call", async () => {
    await expect(
      as(carol, "select public.propose_action($1, 'money.budget', null, $2::jsonb, 'Budget')", [
        tenantA,
        JSON.stringify({ month: "2026-11-01", rows: [] }),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(carol, "select public.propose_config_change($1, 'dashboard', 'main', '{}', 'A change')", [
        tenantA,
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    // The owner still can; the worker (no signed-in person) still can.
    await expect(
      as(alice, "select public.propose_config_change($1, 'dashboard', 'main', '{}', 'A change')", [
        tenantA,
      ]),
    ).resolves.toBeDefined();
    await expect(
      service("select public.save_financial_snapshots($1, 'quickbooks', $2::jsonb)", [
        tenantA,
        JSON.stringify([
          { kind: "balance_sheet", period_start: "2026-11-30", period_end: "2026-11-30", data: {} },
        ]),
      ]),
    ).resolves.toBeDefined();
  });

  it("keeps costs for owners and admins", async () => {
    const sees = async (user: User) =>
      (await as<{ ok: boolean }>(user, "select private.can_see_costs($1) as ok", [tenantA]))[0].ok;
    expect(await sees(carol)).toBe(false);
    expect(await sees(alice)).toBe(true);
    expect(await sees(dan)).toBe(true);
  });
});

describe("a member without a tool", () => {
  it("reads none of its rows and can't write it; their own tools work", async () => {
    await setTools(alice, carol, ["shipping"]);
    expect(await toolsOf(carol)).toEqual(["shipping"]);
    // Not theirs: nothing to read.
    for (const table of ["tickets", "contacts", "social_posts", "services", "suppliers"]) {
      expect(await count(carol, table), table).toBe(0);
    }
    // Shipping shows the shop's items, so Stock's items stay readable to it.
    expect(await count(carol, "stock_items")).toBe(1);
    // Not theirs: no writing.
    await expect(
      as(carol, "select public.save_social_post($1, null, 'No', null, $2, null)", [
        tenantA,
        ["facebook"],
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(carol, "select public.start_ticket($1, 'x@example.test', null, 'Hi')", [tenantA]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(carol, "select public.receive_po_line($1, 1, false)", [await orderedLine()]),
    ).rejects.toMatchObject({ code: "42501" });
    // Messages is everyone's.
    expect(await canUse(carol, "messages")).toBe(true);
    // The owner and the admin still see it all.
    for (const user of [alice, dan]) {
      expect(await count(user, "tickets")).toBe(1);
      expect(await count(user, "social_posts")).toBe(2);
    }
  });

  it("gets a tool back when it is ticked again", async () => {
    await setTools(alice, carol, ["shipping", "stock"]);
    expect(await count(carol, "suppliers")).toBe(1);
    await as(carol, "select public.receive_po_line($1, 1, false)", [await orderedLine()]);
    expect(await count(alice, "stock_receipts")).toBeGreaterThan(0);
    const audit = await db.query<{ n: string }>(
      "select count(*) as n from public.audit_log where tenant_id = $1 and action = 'team.member_tools'",
      [tenantA],
    );
    expect(Number(audit.rows[0].n)).toBe(2);
  });
});

describe("invites", () => {
  it("apply the ticked tools when accepted", async () => {
    const mia = await inviteAndJoin("mia@a.test", "member", ["bookings"]);
    expect(await toolsOf(mia)).toEqual(["bookings"]);
    expect(await canUse(mia, "bookings")).toBe(true);
    expect(await canUse(mia, "stock")).toBe(false);
    expect(await canUse(mia, "dashboard")).toBe(false);
    expect(await count(mia, "services")).toBe(1);
  });

  it("with nothing ticked, or nothing chosen, give no tools at all", async () => {
    const ned = await inviteAndJoin("ned@a.test", "member", []);
    expect(await toolsOf(ned)).toEqual([]);
    const ola = await inviteAndJoin("ola@a.test", "member", null);
    expect(await toolsOf(ola)).toBeNull();
    for (const person of [ned, ola]) {
      for (const tool of ["dashboard", ...MEMBER_TOOLS]) {
        expect(await canUse(person, tool), tool).toBe(false);
      }
      expect(await canUse(person, "messages")).toBe(true);
      expect(await count(person, "stock_items")).toBe(0);
    }
  });

  it("for an admin carry no list: admins have every tool", async () => {
    const pat = await inviteAndJoin("pat@a.test", "admin", ["stock"]);
    expect(await toolsOf(pat)).toBeNull();
    for (const tool of ALL_TOOLS) expect(await canUse(pat, tool)).toBe(true);
  });

  it("still can't make an owner, and members still can't invite", async () => {
    await expect(
      as(alice, "select * from public.create_team_invite($1, 'own@a.test', 'owner', null)", [
        tenantA,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      as(carol, "select * from public.create_team_invite($1, 'z@a.test', 'member', $2::text[])", [
        tenantA,
        ["stock"],
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("switching it off and on again", () => {
  it("gives everyone everything while off, and keeps the lists people chose", async () => {
    await switchTo(dan, false);
    for (const tool of ALL_TOOLS) expect(await canUse(carol, tool)).toBe(true);
    expect(await count(carol, "financial_snapshots")).toBe(2);
    await switchTo(alice, true);
    expect(await toolsOf(carol)).toEqual(["stock", "shipping"]);
    expect(await canUse(carol, "dashboard")).toBe(false);
  });
});

describe("costs and the tools' own checked reads", () => {
  it("keeps what deliveries and postage cost from a member, and nothing else", async () => {
    // carol has Stock and Shipping again (the switch is on).
    const received = (user: User) =>
      as(user, "select * from public.stock_received_costs($1)", [tenantA]);
    expect(await received(carol)).toEqual([]);
    expect((await received(alice)).length).toBeGreaterThan(0);
    const report = async (user: User) =>
      (
        await as<{ r: Record<string, unknown> }>(
          user,
          "select public.shipping_report($1, 30) as r",
          [tenantA],
        )
      )[0].r;
    const mine = await report(carol);
    expect(mine).toHaveProperty("parcels");
    for (const key of ["postage", "collected", "margin", "priced"]) {
      expect(mine).not.toHaveProperty(key);
      expect(await report(alice)).toHaveProperty(key);
    }
  });

  it("refuses Shipping's report, Bookings' seat figures and the help desk outbox without the tool", async () => {
    const ola = { id: "", email: "ola@a.test" };
    ola.id = (
      await db.query<{ id: string }>("select id from auth.users where email = $1", [ola.email])
    ).rows[0].id;
    await setTools(alice, ola, ["social"]);
    await expect(as(ola, "select public.shipping_report($1, 30)", [tenantA])).rejects.toMatchObject(
      { code: "42501" },
    );
    const sessions = (
      await db.query<{ id: string }>("select id from public.sessions where tenant_id = $1", [
        tenantA,
      ])
    ).rows.map((row) => row.id);
    const ticket = (
      await db.query<{ id: string }>("select id from public.tickets where tenant_id = $1", [
        tenantA,
      ])
    ).rows[0].id;
    expect(await as(ola, "select * from public.session_seat_figures($1)", [sessions])).toEqual([]);
    expect(await as(ola, "select * from public.ticket_outbox($1)", [ticket])).toEqual([]);
    expect(await as(ola, "select * from public.eventbrite_order_updates($1)", [tenantA])).toEqual(
      [],
    );
    // The owner still reads them.
    await expect(
      as(alice, "select public.shipping_report($1, 30)", [tenantA]),
    ).resolves.toHaveLength(1);
  });
});
