import type { SupabaseClient } from "@supabase/supabase-js";
import { addMonths } from "./budget";
import { loadDashboardData, loadRevenueSettings } from "./data";
import {
  PROJECTION_KEY,
  PROJECTION_MODULE,
  parseProjectionSettings,
  projection,
  type ProjectionSettings,
  type ProjectionYear,
} from "./projection";
import { currentMonth, startOfLocalDay } from "./range";
import { dashboardSchema } from "./schema";
import type { BusinessLine } from "./lines";

export type ProjectionView = {
  settings: ProjectionSettings;
  lines: BusinessLine[];
  /** The twelve complete months the start is taken from, `YYYY-MM`. */
  months: string[];
  /** How many of them the books have. */
  booked: number;
  years: ProjectionYear[] | null;
};

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The 3-year projection as the member sees it: the books' last twelve
 * complete months, the line mix the revenue widgets show over them, and
 * the workspace's rates. Null years without any of those months booked.
 */
export async function loadProjection(
  supabase: SupabaseClient,
  tenant: { id: string; timezone: string; currency?: string },
  now: Date = new Date(),
): Promise<ProjectionView> {
  const revenue = await loadRevenueSettings(supabase, tenant.id);
  const current = currentMonth(now, tenant.timezone);
  const months = Array.from({ length: 12 }, (_, i) => addMonths(current, i - 12));
  const startOf = (month: string) => {
    const [year, m] = month.split("-").map(Number);
    return startOfLocalDay({ year, month: m, day: 1 }, tenant.timezone);
  };
  const [config, pnl] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", PROJECTION_MODULE)
      .eq("key", PROJECTION_KEY)
      .maybeSingle(),
    supabase
      .from("financial_snapshots")
      .select("period_start, data")
      .eq("tenant_id", tenant.id)
      .eq("kind", "profit_and_loss")
      .gte("period_start", `${months[0]}-01`)
      .lt("period_start", `${current}-01`)
      .order("period_start")
      .limit(100),
  ]);
  if (pnl.error) throw new Error(`Could not load the books: ${pnl.error.message}`);
  const settings = parseProjectionSettings((config.data as { body?: unknown } | null)?.body);
  const booked = (
    (pnl.data ?? []) as { period_start: string; data: Record<string, unknown> }[]
  ).filter((m) => months.includes(m.period_start.slice(0, 7)));
  if (booked.length === 0) {
    return { settings, lines: revenue.lines, months, booked: 0, years: null };
  }
  const sum = (key: string) => booked.reduce((a, m) => a + Math.round(num(m.data?.[key]) * 100), 0);

  // The line mix over the same months, as revenue by line shows it.
  const mix = new Map<string, number>();
  if (revenue.lines.length > 0) {
    const layout = dashboardSchema.parse({
      version: 1,
      name: "Projection",
      widgets: [{ id: "lines", type: "revenue_by_line" }],
    });
    const data = await loadDashboardData(
      supabase,
      tenant,
      layout,
      { from: startOf(months[0]), to: startOf(current), grouping: "month" },
      revenue,
      now,
    );
    const lines = data.lines;
    if (lines?.type === "revenue_by_line") {
      for (const row of lines.rows) {
        const line = revenue.lines.find((l) => l.name === row.name);
        if (line) mix.set(line.id, Math.round(row.value * 100));
      }
    }
  }
  return {
    settings,
    lines: revenue.lines,
    months,
    booked: booked.length,
    years: projection({
      lines: revenue.lines,
      books: { revenue: sum("income"), cogs: sum("cogs"), costs: sum("expenses") },
      mix,
      settings,
      // As the earlier dashboard labels them: next year and the two after.
      firstYear: Number(current.slice(0, 4)) + 1,
    }),
  };
}
