import type { PlanDebt, PlanMonth } from "./engine";

/**
 * The payoff projection, a line per debt (the earlier dashboard's "Payoff
 * projection + emergency fund" chart), told apart the house way: one small
 * chart per debt, plus total owed and the emergency fund, all on one time
 * axis and one money scale, in the one series colour. Pure: the plan's
 * months in, each series' figures (whole cents) and words out. A plan that
 * pays other debts is one debt here, as everywhere.
 */

export type ProjectionSeries = {
  id: string;
  kind: "total" | "debt" | "fund";
  name: string;
  /** End-of-month figures, whole cents, one per month. */
  values: number[];
  /** The month it's cleared (a debt, or all of them); null when not within the plan. */
  payoff: string | null;
  /** Its title's words: "Paid off Nov 2027". */
  words: string;
};

export type Projection = { months: string[]; series: ProjectionSeries[] };

/** Months shown: to a little past the last payoff, at least a year, at most the plan. */
export function projectionLength(plan: readonly PlanMonth[]): number {
  const lastOwing = plan.map((m) => m.total > 0).lastIndexOf(true);
  return Math.min(plan.length, Math.max(12, lastOwing + 3));
}

export function payoffProjection(input: {
  plan: readonly PlanMonth[];
  /** The debts the plan counts (active, owing something), as the engine took them. */
  debts: readonly Pick<PlanDebt, "id" | "name" | "active" | "balance">[];
  fundTarget: number;
  monthWords: (month: string) => string;
  money: (cents: number) => string;
}): Projection {
  const shown = input.plan.slice(0, projectionLength(input.plan));
  const months = shown.map((m) => m.month);
  const paidWords = (payoff: string | null) =>
    payoff ? `Paid off ${input.monthWords(payoff)}` : "Not paid off within five years";

  const debts = input.debts
    .filter((d) => d.active && d.balance > 0)
    .map((d, at) => {
      const values = shown.map((m) => Math.max(0, m.balances[d.id] ?? 0));
      // Paid off within the plan, even if after the months shown.
      const found = input.plan.find((m) => (m.balances[d.id] ?? Infinity) <= 0)?.month ?? null;
      return {
        series: {
          id: d.id,
          kind: "debt" as const,
          name: d.name,
          values,
          payoff: found,
          words: paidWords(found),
        },
        at,
      };
    })
    .sort(
      (a, b) =>
        (a.series.payoff ?? "9999-99").localeCompare(b.series.payoff ?? "9999-99") || a.at - b.at,
    )
    .map((one) => one.series);

  const totals = shown.map((m) => Math.max(0, m.total));
  const freedom = input.plan.find((m) => m.total <= 0)?.month ?? null;
  const total: ProjectionSeries = {
    id: "total",
    kind: "total",
    name: "All your debts",
    values: totals,
    payoff: freedom,
    words: freedom
      ? `Debt-free ${input.monthWords(freedom)}`
      : debts.length > 0
        ? "Not debt-free within five years"
        : "Nothing owed",
  };

  const fund = shown.map((m) => Math.max(0, m.emergencyBalance));
  const reached =
    input.fundTarget > 0
      ? (input.plan.find((m) => m.emergencyBalance >= input.fundTarget)?.month ?? null)
      : null;
  const fundSeries: ProjectionSeries = {
    id: "fund",
    kind: "fund",
    name: "Emergency fund",
    values: fund,
    payoff: reached,
    words:
      input.fundTarget <= 0
        ? "No target set yet"
        : reached
          ? `Reaches ${input.money(input.fundTarget)} ${input.monthWords(reached)}`
          : `Doesn't reach ${input.money(input.fundTarget)} within five years`,
  };

  return { months, series: [total, ...debts, fundSeries] };
}
