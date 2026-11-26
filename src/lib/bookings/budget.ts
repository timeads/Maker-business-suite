import { z } from "zod";

/**
 * The budget: what the classes brought in against what they cost (fixed
 * monthly costs, teaching, materials). Ported from the business's earlier
 * booking app (its `budget.ts`), on whole cents, worked out on read. Pure:
 * nothing here is stored.
 *
 * - Teaching for a date is (class hours + prep and clean-up hours) × the
 *   teacher's hourly rate, unless the date has a flat fee. Classes that start
 *   together with the same teacher share that person: the cost is counted
 *   once, on the longest class.
 * - Materials for a date are its places × (project area in square feet × the
 *   combined rate per square foot, plus the waste allowance, plus each linked
 *   supply's per-person use × its unit cost).
 * - Costs count once the class has happened; later ones are a forecast shown
 *   beside the totals. Fixed costs count for each month that has begun, at
 *   the amounts in force that month.
 */

export const BUDGET_KEY = "budget";

const teacher = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,20}$/),
  name: z.string().trim().min(1).max(60),
  /** Per hour, in cents. */
  hourly_cents: z.number().int().min(0).max(10_000_000),
});

export const budgetSettingsSchema = z.object({
  version: z.literal(1),
  /** Who teaches. The first is who a date has unless it says otherwise. */
  teachers: z
    .array(teacher)
    .min(1)
    .max(10)
    .refine((list) => new Set(list.map((t) => t.id)).size === list.length, "Each teacher once")
    .default([
      { id: "me", name: "You", hourly_cents: 0 },
      { id: "contractor", name: "A teacher you pay", hourly_cents: 0 },
    ]),
  /** Prep and clean-up hours paid on top of each class. */
  overhead_hours: z.number().min(0).max(24).default(2),
  /** Offcuts and mistakes, on the square-foot materials. */
  waste_percent: z.number().int().min(0).max(100).default(10),
});
export type BudgetSettings = z.infer<typeof budgetSettingsSchema>;
export const DEFAULT_BUDGET: BudgetSettings = budgetSettingsSchema.parse({ version: 1 });

export function parseBudgetSettings(body: unknown): BudgetSettings {
  const parsed = budgetSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_BUDGET;
}

export type BudgetSession = {
  id: string;
  service_id: string;
  starts_at: string;
  ends_at: string;
  cancelled: boolean;
  seats: number;
  /** The workshop's project size, inches (0: not set). */
  frame_width_in: number;
  frame_height_in: number;
  /** The date's own: teacher id, flat fee, project size. */
  costs?: {
    teacher: string | null;
    teaching_cents: number | null;
    frame_width_in: number | null;
    frame_height_in: number | null;
  } | null;
};

export type SessionCost = {
  session: BudgetSession;
  hours: number;
  teacher: string;
  frame: string | null;
  teaching_cents: number;
  materials_cents: number;
  total_cents: number;
  /** Another class at the same time with the same teacher carries the teaching. */
  shared_teacher: boolean;
  upcoming: boolean;
};

/** Cents a person, per workshop: each linked active supply's use × its unit cost. */
export function materialsPerStudent(
  supplies: { id: string; active: boolean; per_student: number; unit_cost_cents: number }[],
  links: { supply_id: string; service_id: string }[],
): Map<string, number> {
  const byId = new Map(supplies.map((s) => [s.id, s]));
  const out = new Map<string, number>();
  for (const link of links) {
    const supply = byId.get(link.supply_id);
    if (!supply?.active) continue;
    const cents = supply.per_student * supply.unit_cost_cents;
    if (cents > 0) out.set(link.service_id, (out.get(link.service_id) ?? 0) + cents);
  }
  return out;
}

/** The combined rate across active materials, in hundredths of a cent a square foot. */
export const sqftRate = (rates: { active: boolean; centi_cents_per_sqft: number }[]) =>
  rates.filter((r) => r.active).reduce((n, r) => n + r.centi_cents_per_sqft, 0);

/** Teaching and materials for each date that isn't cancelled, oldest first. */
export function sessionCosts(
  sessions: BudgetSession[],
  opts: {
    settings: BudgetSettings;
    perStudent: Map<string, number>;
    /** Hundredths of a cent a square foot. */
    sqftCentiCents: number;
    now: Date;
  },
): SessionCost[] {
  const rates = new Map(opts.settings.teachers.map((t) => [t.id, t.hourly_cents]));
  const first = opts.settings.teachers[0]?.id ?? "me";
  const overhead = Math.max(0, opts.settings.overhead_hours);
  const waste = 1 + opts.settings.waste_percent / 100;
  const rows = sessions
    .filter((s) => !s.cancelled)
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
    .map((s) => {
      const hours = Math.max(0, (Date.parse(s.ends_at) - Date.parse(s.starts_at)) / 3_600_000);
      const who = s.costs?.teacher && rates.has(s.costs.teacher) ? s.costs.teacher : first;
      const flat = s.costs?.teaching_cents ?? null;
      const w = s.costs?.frame_width_in ?? s.frame_width_in ?? 0;
      const h = s.costs?.frame_height_in ?? s.frame_height_in ?? 0;
      const sqft = (w * h) / 144;
      const perStudent =
        (sqft * opts.sqftCentiCents * waste) / 100 + (opts.perStudent.get(s.service_id) ?? 0);
      return {
        session: s,
        hours,
        teacher: who,
        frame: w && h ? `${w} × ${h} in` : null,
        teaching_cents: flat ?? Math.round((hours + overhead) * (rates.get(who) ?? 0)),
        materials_cents: Math.round(s.seats * perStudent),
        total_cents: 0,
        shared_teacher: false,
        upcoming: Date.parse(s.starts_at) > opts.now.getTime(),
        flat: flat !== null,
      };
    });

  // Classes that start together with the same teacher share them: one
  // teaching cost, on the longest. A flat fee is its own and stays.
  const together = new Map<string, typeof rows>();
  for (const row of rows) {
    if (row.flat) continue;
    const key = `${Date.parse(row.session.starts_at)}|${row.teacher}`;
    together.set(key, [...(together.get(key) ?? []), row]);
  }
  for (const group of together.values()) {
    if (group.length < 2) continue;
    const longest = group.reduce((a, b) => (b.hours > a.hours ? b : a));
    for (const row of group) {
      if (row === longest) continue;
      row.teaching_cents = 0;
      row.shared_teacher = true;
    }
  }
  return rows.map(({ flat: _flat, ...row }) => ({
    ...row,
    total_cents: row.teaching_cents + row.materials_cents,
  }));
}

export type FixedCost = {
  active: boolean;
  monthly_cents: number;
  /** YYYY-MM-DD, the first of a month. */
  from_month: string;
  to_month: string | null;
};

/** Fixed costs for the months given ("YYYY-MM"), each at the amounts in force that month. */
export function fixedForMonths(costs: FixedCost[], months: string[]): number {
  let total = 0;
  for (const month of months) {
    for (const cost of costs) {
      if (!cost.active) continue;
      if (cost.from_month.slice(0, 7) > month) continue;
      if (cost.to_month && month > cost.to_month.slice(0, 7)) continue;
      total += cost.monthly_cents;
    }
  }
  return total;
}

export type BudgetTotals = {
  teaching_cents: number;
  materials_cents: number;
  fixed_cents: number;
  costs_cents: number;
  revenue_cents: number;
  net_cents: number;
  /** Net as a share of revenue, whole percent; null with no revenue. */
  margin: number | null;
  students: number;
  classes: number;
};

/** The headline: money in (bookings and other income) less the costs of classes that happened. */
export function budgetTotals(
  rows: SessionCost[],
  fixedCents: number,
  bookingCents: number,
  otherCents: number,
): BudgetTotals {
  const happened = rows.filter((row) => !row.upcoming);
  const teaching = happened.reduce((n, row) => n + row.teaching_cents, 0);
  const materials = happened.reduce((n, row) => n + row.materials_cents, 0);
  const costs = teaching + materials + fixedCents;
  const revenue = bookingCents + otherCents;
  const net = revenue - costs;
  return {
    teaching_cents: teaching,
    materials_cents: materials,
    fixed_cents: fixedCents,
    costs_cents: costs,
    revenue_cents: revenue,
    net_cents: net,
    margin: revenue > 0 ? Math.round((net / revenue) * 100) : null,
    students: happened.reduce((n, row) => n + row.session.seats, 0),
    classes: happened.filter((row) => row.session.seats > 0).length,
  };
}

export const PERIODS = [
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year_to_date",
  "this_year",
  "last_year",
] as const;
export type PeriodKey = (typeof PERIODS)[number];

export const PERIOD_NAMES: Record<PeriodKey, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_quarter: "This quarter",
  last_quarter: "Last quarter",
  this_year_to_date: "Year to date",
  this_year: "This year",
  last_year: "Last year",
};

const monthKey = (y: number, m: number) => {
  const d = new Date(Date.UTC(y, m, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

export type Period = {
  /** The months it covers, "YYYY-MM". */
  months: string[];
  /** Of those, the ones that have begun by `today`. */
  begun: string[];
  /** First day, and the day after the last, YYYY-MM-DD. */
  from: string;
  until: string;
  label: string;
};

/**
 * A period on the workspace's own calendar. `period` is a preset or a month
 * ("2027-03"); `today` is the workspace's own day, YYYY-MM-DD.
 */
export function periodFor(period: string, today: string): Period {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7)) - 1;
  const q = Math.floor(m / 3) * 3;
  let start: [number, number];
  let count: number;
  let label: string;
  const month = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(period);
  if (month) {
    start = [Number(month[1]), Number(month[2]) - 1];
    count = 1;
    label = "";
  } else {
    const key = (PERIODS as readonly string[]).includes(period)
      ? (period as PeriodKey)
      : "this_month";
    const table: Record<PeriodKey, [[number, number], number]> = {
      this_month: [[y, m], 1],
      last_month: [[y, m - 1], 1],
      this_quarter: [[y, q], 3],
      last_quarter: [[y, q - 3], 3],
      this_year_to_date: [[y, 0], m + 1],
      this_year: [[y, 0], 12],
      last_year: [[y - 1, 0], 12],
    };
    [start, count] = table[key];
    label = PERIOD_NAMES[key];
  }
  const months = Array.from({ length: count }, (_, i) => monthKey(start[0], start[1] + i));
  const now = today.slice(0, 7);
  const after = monthKey(start[0], start[1] + count);
  if (!label) {
    label = new Intl.DateTimeFormat("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${months[0]}-01T12:00:00Z`));
  }
  return {
    months,
    begun: months.filter((each) => each <= now),
    from: `${months[0]}-01`,
    until: `${after}-01`,
    label,
  };
}

/** "$1,234.56" from cents. */
export const dollars = (cents: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
