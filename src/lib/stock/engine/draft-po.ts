import { addDays } from "./days";
import type { MoqAppliesTo } from "./types";

export interface DraftPoLineInput {
  variantId: string;
  suggestedQty: number;
  unitCost: string; // carried through unchanged (money stays a string/Decimal)
  effectiveLeadTimeDays: number;
}

export interface DraftPoLine {
  variantId: string;
  qty: number;
  unitCost: string;
}

export interface DraftPoResult {
  lines: DraftPoLine[];
  totalUnits: number;
  estDeliveryDate: Date;
  moqBumped: boolean;
}

/**
 * Build one supplier's draft PO from suggested lines (docs/04 §5). Drops zero-qty
 * lines. If the supplier's MOQ applies per ORDER and the total is below it, scale
 * every line up proportionally with largest-remainder rounding so the total lands
 * exactly on the MOQ. Estimated delivery = today + the max lead time across lines.
 */
export function computeDraftPo(
  lines: DraftPoLineInput[],
  moq: number,
  moqAppliesTo: MoqAppliesTo,
  today: Date,
): DraftPoResult {
  const candidates = lines.filter((l) => l.suggestedQty > 0);

  let qtys = candidates.map((l) => l.suggestedQty);
  let total = qtys.reduce((a, b) => a + b, 0);
  let moqBumped = false;

  if (moqAppliesTo === "ORDER" && moq > 1 && total > 0 && total < moq) {
    qtys = largestRemainder(qtys, moq);
    total = moq;
    moqBumped = true;
  }

  const maxLead = candidates.reduce((m, l) => Math.max(m, l.effectiveLeadTimeDays), 0);

  return {
    lines: candidates.map((l, i) => ({
      variantId: l.variantId,
      qty: qtys[i]!,
      unitCost: l.unitCost,
    })),
    totalUnits: total,
    estDeliveryDate: addDays(today, maxLead),
    moqBumped,
  };
}

/** Scale `weights` so they sum to exactly `target`, using largest-remainder rounding. */
export function largestRemainder(weights: number[], target: number): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return weights.map(() => 0);

  const ideals = weights.map((w) => (target * w) / total);
  const floors = ideals.map((v) => Math.floor(v));
  const allocated = floors.reduce((a, b) => a + b, 0);
  let remainder = target - allocated;

  const order = ideals
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);

  const result = [...floors];
  let k = 0;
  while (remainder > 0 && order.length > 0) {
    result[order[k % order.length]!.i]! += 1;
    remainder--;
    k++;
  }
  return result;
}
