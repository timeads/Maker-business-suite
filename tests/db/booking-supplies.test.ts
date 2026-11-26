import type { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createTestDb, createUser } from "./harness";

/**
 * Classroom supplies, vendors and the budget, in the database:
 *   - only owners and admins write, and only through the functions;
 *   - the whole team reads supplies and vendors, only managers the budget;
 *   - an order is received once;
 *   - nothing reaches another workspace: its vendors, workshops or dates.
 */
type User = { id: string; email: string };

let db: PGlite;
let alice: User; // owner of A
let carol: User; // member of A
let bob: User; // owner of B
let tenantA: string;
let tenantB: string;
let workshopA: string;
let workshopB: string;

const as = <T>(user: User, sql: string, params: unknown[] = []) =>
  asUser(db, user, async (tx) => (await tx.query<T>(sql, params)).rows);
const one = async <T>(user: User, sql: string, params: unknown[] = []) =>
  (await as<{ r: T }>(user, sql, params))[0].r;

async function tenantFor(user: User, name: string) {
  return one<string>(user, "select id as r from public.create_tenant($1, 'UTC', 'USD')", [name]);
}
const workshop = (user: User, tenant: string, name: string) =>
  one<string>(
    user,
    "select public.save_service($1, null, 'workshop', $2, '', 120, 0, 8, true) as r",
    [tenant, name],
  );
const supply = (user: User, tenant: string, fields: object, services: string[], count = 0) =>
  one<string>(user, "select public.save_class_supply($1, null, $2::jsonb, $3, $4) as r", [
    tenant,
    JSON.stringify(fields),
    services,
    count,
  ]);

beforeAll(async () => {
  db = await createTestDb();
  alice = { id: await createUser(db, "alice@example.com"), email: "alice@example.com" };
  carol = { id: await createUser(db, "carol@example.com"), email: "carol@example.com" };
  bob = { id: await createUser(db, "bob@example.com"), email: "bob@example.com" };
  tenantA = await tenantFor(alice, "Alice Studio");
  tenantB = await tenantFor(bob, "Bob Studio");
  await db.query(
    "insert into public.memberships (tenant_id, user_id, role) values ($1, $2, 'member')",
    [tenantA, carol.id],
  );
  workshopA = await workshop(alice, tenantA, "Rugs");
  workshopB = await workshop(bob, tenantB, "Pots");
});

describe("classroom supplies", () => {
  let yarn: string;
  let vendor: string;

  it("lets a manager add a vendor and a supply, starting from a count", async () => {
    vendor = await one(
      alice,
      "select public.save_class_vendor($1, null, 'Yarn Co', 'orders@example.com', 'https://yarn.example', 'Min 10') as r",
      [tenantA],
    );
    yarn = await supply(
      alice,
      tenantA,
      { name: "Yarn", vendor_id: vendor, per_student: 1.5, unit_cost_cents: 250 },
      [workshopA],
      40,
    );
    const [row] = await as<{ name: string; per_student: string; vendor_id: string }>(
      carol,
      "select name, per_student, vendor_id from public.class_supplies",
    );
    expect(row).toEqual({ name: "Yarn", per_student: "1.500", vendor_id: vendor });
    expect(await as(carol, "select kind, qty from public.class_supply_entries")).toEqual([
      { kind: "count", qty: "40.000" },
    ]);
    expect(await as(carol, "select service_id from public.class_supply_services")).toEqual([
      { service_id: workshopA },
    ]);
  });

  it("never links another workspace's workshop or vendor", async () => {
    const sneaky = await supply(alice, tenantA, { name: "Glue" }, [workshopA, workshopB]);
    expect(
      await as(alice, "select service_id from public.class_supply_services where supply_id = $1", [
        sneaky,
      ]),
    ).toEqual([{ service_id: workshopA }]);
    const theirs = await one<string>(
      bob,
      "select public.save_class_vendor($1, null, 'Clay', '', '', '') as r",
      [tenantB],
    );
    await expect(supply(alice, tenantA, { name: "Clay", vendor_id: theirs }, [])).rejects.toThrow(
      /Vendor not found/,
    );
  });

  it("receives an order once, as a delivery", async () => {
    const order = await one<string>(
      alice,
      "select public.place_class_supply_order($1, 30, '2027-04-01', '') as r",
      [yarn],
    );
    expect(await one(alice, "select public.receive_class_supply_order($1) as r", [order])).toBe(
      "received",
    );
    expect(await one(alice, "select public.receive_class_supply_order($1) as r", [order])).toBe(
      "already",
    );
    const entries = await as<{ kind: string; qty: string }>(
      alice,
      "select kind, qty from public.class_supply_entries where supply_id = $1 order by at",
      [yarn],
    );
    expect(entries.map((e) => e.kind)).toEqual(["count", "received"]);
    expect(entries[1].qty).toBe("30.000");
  });

  it("keeps every write to owners and admins, and to the workspace's own", async () => {
    await expect(
      as(carol, "select public.add_class_supply_entry($1, 'count', 10, '')", [yarn]),
    ).rejects.toThrow(/owners and admins/);
    await expect(
      as(bob, "select public.add_class_supply_entry($1, 'adjustment', -1, '')", [yarn]),
    ).rejects.toThrow(/owners and admins/);
    await expect(
      as(bob, "select public.delete_class_vendor($1, $2)", [tenantA, vendor]),
    ).rejects.toThrow(/owners and admins/);
    await expect(
      as(alice, "insert into public.class_supplies (tenant_id, name) values ($1, 'x')", [tenantA]),
    ).rejects.toThrow(/permission denied/);
    await expect(as(alice, "update public.class_supply_entries set qty = 1")).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      as(alice, "select public.add_class_supply_entry($1, 'adjustment', 0, '')", [yarn]),
    ).rejects.toThrow(/amount/);
    expect((await as(bob, "select id from public.class_supplies")).length).toBe(0);
    expect(await as(bob, "select id from public.class_supply_entries")).toEqual([]);
    expect(await as(bob, "select id from public.class_supply_orders")).toEqual([]);
    expect((await as(bob, "select id from public.class_vendors")).length).toBe(1);
    await expect(
      asAnon(db, (tx) => tx.query("select * from public.class_supplies")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("the budget", () => {
  it("is kept by managers and read only by them", async () => {
    await as(
      alice,
      "select public.save_budget_fixed_cost($1, null, 'Rent', 150000, '2027-01-15', null, true)",
      [tenantA],
    );
    await as(alice, "select public.save_budget_material_rate($1, null, 'Yarn', 4500, true)", [
      tenantA,
    ]);
    await as(
      alice,
      "select public.save_budget_other_income($1, null, 'Private class', 30000, '2027-02-02')",
      [tenantA],
    );
    expect(await as(alice, "select from_month::text as m from public.budget_fixed_costs")).toEqual([
      { m: "2027-01-01" },
    ]);
    // The team can't see what things cost; another workspace sees nothing.
    expect(await as(carol, "select id from public.budget_fixed_costs")).toEqual([]);
    expect(await as(carol, "select id from public.budget_other_income")).toEqual([]);
    expect(await as(bob, "select id from public.budget_material_rates")).toEqual([]);
    await expect(
      as(carol, "select public.save_budget_other_income($1, null, 'x', 1, '2027-01-01')", [
        tenantA,
      ]),
    ).rejects.toThrow(/owners and admins/);
    await expect(
      as(bob, "select public.delete_budget_row($1, 'fixed', gen_random_uuid())", [tenantA]),
    ).rejects.toThrow(/owners and admins/);
  });

  it("sets a date's own costs only for the workspace's own dates", async () => {
    const date = await one<string>(
      alice,
      "select public.add_session($1, now() - interval '1 day', null) as r",
      [workshopA],
    );
    const theirs = await one<string>(
      bob,
      "select public.add_session($1, now() - interval '1 day', null) as r",
      [workshopB],
    );
    const changed = await one<number>(
      alice,
      'select public.set_session_costs($1, $2, \'{"teacher": "pat", "teaching_cents": 5000}\'::jsonb) as r',
      [tenantA, [date, theirs]],
    );
    expect(changed).toBe(1);
    expect(
      await as(alice, "select session_id, teacher, teaching_cents from public.session_costs"),
    ).toEqual([{ session_id: date, teacher: "pat", teaching_cents: 5000 }]);
    // Only the keys handed over change.
    await as(
      alice,
      "select public.set_session_costs($1, $2, '{\"teaching_cents\": null}'::jsonb)",
      [tenantA, [date]],
    );
    expect(await as(alice, "select teacher, teaching_cents from public.session_costs")).toEqual([
      { teacher: "pat", teaching_cents: null },
    ]);
    await expect(
      as(bob, "select public.set_service_frame($1, 24, 24)", [workshopA]),
    ).rejects.toThrow(/owners and admins/);
    await as(alice, "select public.set_service_frame($1, 24, 18)", [workshopA]);
    expect(
      await as(carol, "select frame_width_in, frame_height_in from public.services where id = $1", [
        workshopA,
      ]),
    ).toEqual([{ frame_width_in: "24.00", frame_height_in: "18.00" }]);
  });
});
