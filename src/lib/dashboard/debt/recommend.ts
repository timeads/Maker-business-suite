import {
  STRATEGIES,
  STRATEGY_META,
  debtPlan,
  type DebtPlan,
  type PlanInput,
  type SimulationResult,
  type Strategy,
} from "./engine";

/**
 * Which of the four orders the plan recommends: the one that makes the most
 * financial sense. Pure, on the engine's own results (whole cents).
 *
 * The earlier dashboard ran the same four orders side by side, marked the
 * cheapest ("Cheapest") and the fastest ("Fastest"), and started a workspace
 * on avalanche until a person picked another. Here one is marked
 * "Recommended", by this rule, in this order:
 *
 * 1. an order that clears every debt within the engine's 50 years beats one
 *    that doesn't (a capped run's interest stops counting at the cap, so it
 *    can't be compared fairly);
 * 2. the least total interest paid over the plan;
 * 3. on equal interest (to the cent), the sooner debt-free month;
 * 4. on both equal, the dashboard's own order of preference: avalanche,
 *    snowball, hybrid, then your own order (`STRATEGIES`).
 *
 * Debts on a fixed plan, on hold, or paid from sales are not in the
 * comparison: the engine keeps their own rules, as it always has.
 */

export const PREFERENCE: readonly Strategy[] = STRATEGIES;

export function rankStrategies(sims: Record<Strategy, SimulationResult>): Strategy[] {
  return [...PREFERENCE].sort((a, b) => {
    const x = sims[a];
    const y = sims[b];
    return (
      Number(x.capped) - Number(y.capped) ||
      x.totalInterest - y.totalInterest ||
      x.monthsToFreedom - y.monthsToFreedom ||
      PREFERENCE.indexOf(a) - PREFERENCE.indexOf(b)
    );
  });
}

export type Recommendation = {
  strategy: Strategy;
  /** Best first. */
  ranked: Strategy[];
  /** Against paying only the minimums; null when minimums never clear the debts. */
  savedVsMinimums: number | null;
  monthsSoonerVsMinimums: number | null;
  /** The next order down, and how much more interest it pays and how much later it finishes. */
  next: { strategy: Strategy; moreInterest: number; monthsLater: number } | null;
};

export function recommendStrategy(
  sims: Record<Strategy, SimulationResult>,
  minimumsOnly: SimulationResult,
): Recommendation {
  const ranked = rankStrategies(sims);
  const best = sims[ranked[0]];
  const nextKey = ranked.find((s) => s !== ranked[0]) ?? null;
  const next = nextKey ? sims[nextKey] : null;
  const vsMinimums = !minimumsOnly.capped && !best.capped;
  return {
    strategy: ranked[0],
    ranked,
    savedVsMinimums: vsMinimums ? minimumsOnly.totalInterest - best.totalInterest : null,
    monthsSoonerVsMinimums: vsMinimums ? minimumsOnly.monthsToFreedom - best.monthsToFreedom : null,
    next:
      next && nextKey
        ? {
            strategy: nextKey,
            moreInterest: next.totalInterest - best.totalInterest,
            monthsLater: next.monthsToFreedom - best.monthsToFreedom,
          }
        : null,
  };
}

const months = (n: number) => `${n} ${n === 1 ? "month" : "months"}`;

/**
 * Why, in one plain sentence: what the recommended order saves against
 * paying only the minimums, else against the next best, else that the
 * orders come out the same.
 */
export function recommendationWords(rec: Recommendation, money: (cents: number) => string): string {
  const name = STRATEGY_META[rec.strategy].label;
  if (rec.savedVsMinimums !== null && rec.savedVsMinimums > 0) {
    const sooner =
      rec.monthsSoonerVsMinimums !== null && rec.monthsSoonerVsMinimums > 0
        ? ` and finishes ${months(rec.monthsSoonerVsMinimums)} sooner`
        : "";
    const nextWords =
      rec.next && rec.next.moreInterest > 0
        ? `; the next best, ${STRATEGY_META[rec.next.strategy].label.toLowerCase()}, pays about ${money(rec.next.moreInterest)} more`
        : "";
    return `${name} saves about ${money(rec.savedVsMinimums)} in interest${sooner} than paying only the minimums${nextWords}.`;
  }
  if (rec.next && (rec.next.moreInterest > 0 || rec.next.monthsLater > 0)) {
    const parts = [
      rec.next.moreInterest > 0 ? `saves about ${money(rec.next.moreInterest)} in interest` : "",
      rec.next.monthsLater > 0 ? `finishes ${months(rec.next.monthsLater)} sooner` : "",
    ].filter(Boolean);
    return `${name} ${parts.join(" and ")} than the next best, ${STRATEGY_META[rec.next.strategy].label.toLowerCase()}.`;
  }
  return `The orders come out the same here, so ${name.toLowerCase()} is the one to follow.`;
}

/**
 * The quiet note for a person who chose their own order: how much less
 * interest the recommended one would pay now. Null when theirs is the
 * recommended one, or it pays no more.
 */
export function choiceNote(
  chosen: Strategy,
  rec: Recommendation,
  sims: Record<Strategy, SimulationResult>,
  money: (cents: number) => string,
): string | null {
  if (chosen === rec.strategy) return null;
  const more = sims[chosen].totalInterest - sims[rec.strategy].totalInterest;
  if (more <= 0 || sims[rec.strategy].capped) return null;
  return `${STRATEGY_META[rec.strategy].label} would now save about ${money(more)} more in interest than the order you chose.`;
}

/**
 * The plan in the order it follows: every order is worked out either way,
 * and the recommended one is followed unless a person chose their own
 * (`chosen` from the setting; a person's choice always wins and sticks).
 */
export function followOrder(
  input: PlanInput & { hybridThreshold?: number },
  chosen: { from: "recommended" | "person"; strategy: Strategy },
): { strategy: Strategy; result: DebtPlan; recommendation: Recommendation | null } {
  const first = debtPlan({ ...input, strategy: chosen.strategy });
  const recommendation =
    first.poolDebts.length > 0 ? recommendStrategy(first.sims, first.minimumsOnly) : null;
  if (chosen.from === "person" || !recommendation || recommendation.strategy === chosen.strategy) {
    return { strategy: chosen.strategy, result: first, recommendation };
  }
  return {
    strategy: recommendation.strategy,
    result: debtPlan({ ...input, strategy: recommendation.strategy }),
    recommendation,
  };
}
