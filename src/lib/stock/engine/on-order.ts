export interface OnOrderLine {
  status: string; // PoStatus
  qtyOrdered: number;
  qtyReceived: number;
}

/**
 * On-order units for a variant (docs/02, docs/04 §9): sum of the outstanding
 * remainder (qtyOrdered − qtyReceived) across the variant's PO lines whose PO is
 * ORDERED or PARTIAL. DRAFT and CLOSED/ARCHIVED are excluded. Over-received lines
 * clamp at 0 (they don't reduce the on-order figure).
 */
export function computeOnOrder(lines: OnOrderLine[]): number {
  return lines
    .filter((l) => l.status === "ORDERED" || l.status === "PARTIAL")
    .reduce((sum, l) => sum + Math.max(0, l.qtyOrdered - l.qtyReceived), 0);
}
