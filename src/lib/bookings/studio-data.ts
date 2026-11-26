import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSeatFigures } from "./seats";
import {
  estimateOrderDays,
  onHand,
  project,
  suggestQty,
  weeklyRate,
  type ClassRun,
  type Entry,
  type OnHand,
  type Projection,
  type Supply,
  type SupplyOrder,
} from "./supplies";

/**
 * What the supplies page shows, read as the signed-in member and worked out
 * by the pure functions in `supplies.ts`. Nothing here is stored.
 */

export type SupplyRow = Supply & {
  name: string;
  vendor_id: string | null;
  unit: string;
  unit_cost_cents: number;
  notes: string;
};
export type VendorRow = { id: string; name: string; email: string; website: string; note: string };
export type OrderRow = SupplyOrder & { id: string; placed_on: string; note: string };
export type EntryRow = Entry & { id: string; note: string };

export type SupplyFigures = {
  supply: SupplyRow;
  linked: Set<string>;
  stock: OnHand;
  incoming: number;
  /** The soonest open order's expected day. */
  arriving: string | null;
  projection: Projection;
  suggested: number;
  estimateDays: number | null;
};

const n = (value: unknown) => Number(value ?? 0);

/** The dates of the workspace's workshops from `since`, with the places taken on each. */
export async function loadClassRuns(
  supabase: SupabaseClient,
  tenantId: string,
  since: Date,
  until: Date,
): Promise<(ClassRun & { id: string; ends_at: string })[]> {
  const { data } = await supabase
    .from("sessions")
    .select("id, service_id, starts_at, ends_at, cancelled_at")
    .eq("tenant_id", tenantId)
    .gte("starts_at", since.toISOString())
    .lt("starts_at", until.toISOString())
    .order("starts_at")
    .limit(1000);
  const rows = (data ?? []) as {
    id: string;
    service_id: string;
    starts_at: string;
    ends_at: string;
    cancelled_at: string | null;
  }[];
  const figures = await loadSeatFigures(
    supabase,
    rows.map((row) => row.id),
  );
  return rows.map((row) => ({
    id: row.id,
    service_id: row.service_id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    cancelled: row.cancelled_at !== null,
    seats: figures.get(row.id)?.taken ?? 0,
  }));
}

export async function loadSupplies(
  supabase: SupabaseClient,
  tenantId: string,
  timeZone: string,
  now = new Date(),
) {
  const [supplies, links, entries, orders, vendors] = await Promise.all([
    supabase
      .from("class_supplies")
      .select(
        "id, name, vendor_id, per_student, lead_time_days, safety_stock, coverage_days, unit_cost_cents, unit, notes, active, counts_from",
      )
      .eq("tenant_id", tenantId)
      .order("name"),
    supabase
      .from("class_supply_services")
      .select("supply_id, service_id")
      .eq("tenant_id", tenantId),
    supabase
      .from("class_supply_entries")
      .select("id, supply_id, kind, qty, at, note")
      .eq("tenant_id", tenantId)
      .order("at")
      .limit(5000),
    supabase
      .from("class_supply_orders")
      .select("id, supply_id, qty, placed_on, expected_on, status, note")
      .eq("tenant_id", tenantId)
      .order("expected_on")
      .limit(1000),
    supabase
      .from("class_vendors")
      .select("id, name, email, website, note")
      .eq("tenant_id", tenantId)
      .order("name"),
  ]);
  const supplyRows: SupplyRow[] = ((supplies.data ?? []) as Record<string, unknown>[]).map((s) => ({
    id: String(s.id),
    name: String(s.name),
    vendor_id: (s.vendor_id as string | null) ?? null,
    per_student: n(s.per_student),
    lead_time_days: n(s.lead_time_days),
    safety_stock: n(s.safety_stock),
    coverage_days: n(s.coverage_days),
    unit_cost_cents: n(s.unit_cost_cents),
    unit: String(s.unit ?? ""),
    notes: String(s.notes ?? ""),
    active: Boolean(s.active),
    counts_from: String(s.counts_from),
  }));
  const entryRows: EntryRow[] = ((entries.data ?? []) as Record<string, unknown>[]).map((e) => ({
    id: String(e.id),
    supply_id: String(e.supply_id),
    kind: e.kind as Entry["kind"],
    qty: n(e.qty),
    at: String(e.at),
    note: String(e.note ?? ""),
  }));
  const orderRows: OrderRow[] = ((orders.data ?? []) as Record<string, unknown>[]).map((o) => ({
    id: String(o.id),
    supply_id: String(o.supply_id),
    qty: n(o.qty),
    placed_on: String(o.placed_on),
    expected_on: String(o.expected_on),
    status: o.status as SupplyOrder["status"],
    note: String(o.note ?? ""),
  }));
  const linkRows = (links.data ?? []) as { supply_id: string; service_id: string }[];

  // From the earliest moment any supply still counts from, a year at most.
  const counted = supplyRows.map((s) => {
    const last = [...entryRows].reverse().find((e) => e.supply_id === s.id && e.kind === "count");
    return Math.max(Date.parse(s.counts_from), last ? Date.parse(last.at) : 0);
  });
  const earliest = Math.max(
    Math.min(now.getTime() - 8 * 7 * 86_400_000, ...counted),
    now.getTime() - 365 * 86_400_000,
  );
  const runs = await loadClassRuns(
    supabase,
    tenantId,
    new Date(earliest),
    new Date(now.getTime() + 365 * 86_400_000),
  );
  const open = orderRows.filter((o) => o.status === "open");

  const figures: SupplyFigures[] = supplyRows.map((supply) => {
    const linked = new Set(
      linkRows.filter((l) => l.supply_id === supply.id).map((l) => l.service_id),
    );
    const stock = onHand(supply, entryRows, runs, linked, now);
    const mine = open.filter((o) => o.supply_id === supply.id);
    const incoming = mine.reduce((sum, o) => sum + o.qty, 0);
    const rate = weeklyRate(runs, linked, now);
    return {
      supply,
      linked,
      stock,
      incoming,
      arriving: mine[0]?.expected_on ?? null,
      projection: project(supply, stock.qty, runs, mine, linked, now, timeZone),
      suggested: supply.active ? suggestQty(supply, rate, stock.qty, incoming) : 0,
      estimateDays: estimateOrderDays(supply, rate, stock.qty, incoming),
    };
  });
  return {
    figures,
    entries: entryRows,
    orders: orderRows,
    vendors: (vendors.data ?? []) as VendorRow[],
    links: linkRows,
    error: supplies.error ?? entries.error ?? null,
  };
}
