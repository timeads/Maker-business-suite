"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatMoney } from "@/lib/dashboard/format";
import { caseLabel, casesFor } from "@/lib/stock/engine";
import { computePoTotals, type PoTotals } from "@/lib/stock/po/totals";
import { saveOrder } from "../../actions";
import { Result, type OrderLine } from "../../forms";

export type EditLine = OrderLine & {
  /** What the sales history says to order now, in whole cases. Zero when there's enough. */
  suggested: number;
  /** How that number was reached, in plain words. */
  why: string;
};
export type AddableItem = {
  id: string;
  name: string;
  cost: number;
  /** Where "how many" starts: the suggestion, else one case, else one. */
  start: number;
  case_pack: number | null;
  why: string;
};
type Draft = { qty: string; cost: string };
type Adjustment = { label: string; amount: string };

const MAX_ADJUSTMENTS = 12;

function totalsOf(
  lines: { qty: string; cost: string }[],
  shipping: string,
  tax: string,
  adjustments: Adjustment[],
): PoTotals | null {
  try {
    return computePoTotals({
      lines: lines.map((line) => ({
        qtyOrdered: Number.parseInt(line.qty || "0", 10) || 0,
        unitCost: line.cost || "0",
      })),
      shippingCost: shipping || "0",
      taxRatePct: tax || "0",
      adjustments: adjustments.filter((a) => a.amount.trim()).map((a) => ({ amount: a.amount })),
    });
  } catch {
    // Something half-typed ("12." or "-"): no total until it's a number again.
    return null;
  }
}

/**
 * An order's lines and money. Every quantity starts at what the sales history
 * suggests and can be changed; items bought by the case can be typed in cases
 * or units. Used for a draft, and for an order that has gone out until it's closed.
 */
export function OrderForm({
  slug,
  orderId,
  placed,
  lines,
  notes,
  expected,
  shipping,
  tax,
  adjustments,
  addable,
  currency,
}: {
  slug: string;
  orderId: string;
  /** Already sent to the supplier: changes here are to match what was agreed or arrived. */
  placed: boolean;
  lines: EditLine[];
  notes: string;
  expected: string | null;
  shipping: string;
  tax: string;
  adjustments: Adjustment[];
  addable: AddableItem[];
  currency: string;
}) {
  const [state, action] = useActionState(saveOrder.bind(null, slug, orderId), {});
  const fresh = () => ({
    drafts: Object.fromEntries(
      lines.map((line) => [
        line.stock_item_id,
        { qty: String(line.qty_ordered), cost: line.unit_cost.toFixed(2) },
      ]),
    ) as Record<string, Draft>,
    shipping: Number(shipping) ? shipping : "",
    tax: Number(tax) ? String(Number(tax)) : "",
    adjustments: adjustments.length > 0 ? adjustments : [],
    add: { item: "", qty: "", cost: "" },
  });
  // What was last saved, as one string: when the server sends something new
  // (after a save, or someone else's change) the boxes start again from it.
  const saved = JSON.stringify([lines, shipping, tax, adjustments]);
  const [seen, setSeen] = useState(saved);
  const [held, setForm] = useState(fresh);
  let form = held;
  if (seen !== saved) {
    form = fresh();
    setSeen(saved);
    setForm(form);
  }

  const setDraft = (id: string, change: Partial<Draft>) =>
    setForm((now) => ({
      ...now,
      drafts: { ...now.drafts, [id]: { ...now.drafts[id], ...change } },
    }));
  const setAdjustment = (index: number, change: Partial<Adjustment>) =>
    setForm((now) => ({
      ...now,
      adjustments: now.adjustments.map((a, i) => (i === index ? { ...a, ...change } : a)),
    }));
  const adding = addable.find((item) => item.id === form.add.item);
  const money = (value: number) => formatMoney(value, currency);
  const totals = totalsOf(
    [
      ...lines.map((line) => form.drafts[line.stock_item_id]),
      ...(adding ? [{ qty: form.add.qty, cost: form.add.cost }] : []),
    ],
    form.shipping,
    form.tax,
    form.adjustments,
  );

  return (
    <form action={action} className="flex flex-col gap-5">
      {placed && (
        <p className="bg-panel font-read rounded-md px-3 py-2 text-sm">
          This order has gone out. You can still change it to match what you agreed with the
          supplier, or what really arrived, until it&apos;s closed.
        </p>
      )}
      {lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="py-2 pr-3 font-semibold">Item</th>
                <th className="w-28 py-2 pr-3 font-semibold">How many</th>
                <th className="w-24 py-2 pr-3 font-semibold">Cases</th>
                <th className="w-28 py-2 pr-3 font-semibold">Cost each ({currency})</th>
                <th className="w-36 py-2 pr-3 font-semibold">Supplier&apos;s code</th>
                <th className="w-52 py-2 font-semibold">Note</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {lines.map((line) => {
                const draft = form.drafts[line.stock_item_id];
                const qty = Number.parseInt(draft.qty || "0", 10) || 0;
                const pack = line.case_pack;
                return (
                  <tr key={line.id} className="align-top">
                    <td className="py-2 pr-3">
                      <span className="font-read">{line.name}</span>
                      {line.sku && (
                        <span className="text-muted-foreground block text-xs">{line.sku}</span>
                      )}
                      <span className="text-muted-foreground font-read mt-1 block max-w-md text-xs">
                        {line.why}
                      </span>
                      {placed && line.qty_received > 0 && (
                        <span className="text-muted-foreground block text-xs tabular-nums">
                          {line.qty_received} arrived so far
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        name={`qty_${line.stock_item_id}`}
                        type="number"
                        min={0}
                        step={1}
                        value={draft.qty}
                        onChange={(e) => setDraft(line.stock_item_id, { qty: e.target.value })}
                        aria-label={`How many ${line.name}`}
                      />
                      {line.suggested > 0 && line.suggested !== qty && (
                        <button
                          type="button"
                          className="text-ochre-text mt-1 text-xs underline-offset-2 hover:underline"
                          onClick={() =>
                            setDraft(line.stock_item_id, { qty: String(line.suggested) })
                          }
                        >
                          Use the suggested {line.suggested}
                        </button>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      {pack ? (
                        <>
                          <Input
                            type="number"
                            min={0}
                            step="any"
                            value={qty ? casesFor(qty, pack) : ""}
                            onChange={(e) => {
                              const cases = Number.parseFloat(e.target.value || "0");
                              setDraft(line.stock_item_id, {
                                qty: String(
                                  Math.max(
                                    0,
                                    Math.round((Number.isFinite(cases) ? cases : 0) * pack),
                                  ),
                                ),
                              });
                            }}
                            aria-label={`Cases of ${line.name}`}
                          />
                          <span className="text-muted-foreground mt-1 block text-xs whitespace-nowrap">
                            {caseLabel(qty, pack) ?? `${pack} to a case`}
                          </span>
                        </>
                      ) : (
                        <span
                          className="text-muted-foreground block pt-2 text-xs"
                          title="Set how many come in a case on the item's own page to order it by the case."
                        >
                          single units
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        name={`cost_${line.stock_item_id}`}
                        type="number"
                        min={0}
                        step="0.01"
                        value={draft.cost}
                        onChange={(e) => setDraft(line.stock_item_id, { cost: e.target.value })}
                        aria-label={`Cost of each ${line.name}`}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <Input
                        name={`ssku_${line.stock_item_id}`}
                        maxLength={120}
                        defaultValue={line.supplier_sku ?? ""}
                        aria-label={`Supplier's code for ${line.name}`}
                      />
                    </td>
                    <td className="py-2">
                      <Input
                        name={`note_${line.stock_item_id}`}
                        maxLength={500}
                        defaultValue={line.note}
                        aria-label={`Note about ${line.name}`}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-muted-foreground mt-1 text-xs">Set a line to 0 to take it off.</p>
        </div>
      )}

      {addable.length > 0 && (
        <div className="bg-panel flex flex-col gap-2 rounded-md p-3">
          <div className="grid gap-3 sm:grid-cols-[1fr_7rem_8rem]">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-item">Add an item</Label>
              <Select
                id="add-item"
                name="add_item"
                value={form.add.item}
                onChange={(e) => {
                  const item = addable.find((a) => a.id === e.target.value);
                  // The quantity starts at what the sales history suggests.
                  setForm((now) => ({
                    ...now,
                    add: item
                      ? { item: item.id, qty: String(item.start), cost: item.cost.toFixed(2) }
                      : { item: "", qty: "", cost: "" },
                  }));
                }}
              >
                <option value="">Nothing to add</option>
                {addable.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-qty">How many</Label>
              <Input
                id="add-qty"
                name="add_qty"
                type="number"
                min={1}
                step={1}
                value={form.add.qty}
                onChange={(e) =>
                  setForm((now) => ({ ...now, add: { ...now.add, qty: e.target.value } }))
                }
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="add-cost">Cost each</Label>
              <Input
                id="add-cost"
                name="add_cost"
                type="number"
                min={0}
                step="0.01"
                value={form.add.cost}
                onChange={(e) =>
                  setForm((now) => ({ ...now, add: { ...now.add, cost: e.target.value } }))
                }
              />
            </div>
          </div>
          <p className="text-muted-foreground font-read text-xs">
            {adding
              ? `${adding.why}${
                  caseLabel(Number.parseInt(form.add.qty || "0", 10) || 0, adding.case_pack)
                    ? ` That's ${caseLabel(Number.parseInt(form.add.qty || "0", 10) || 0, adding.case_pack)}.`
                    : ""
                }`
              : "Pick an item and “how many” fills in from its sales. Leave it empty and we'll use the suggested amount."}
          </p>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-expected">Expected to arrive</Label>
              <Input
                id="order-expected"
                name="expected"
                type="date"
                defaultValue={expected ?? ""}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-shipping">Shipping ({currency})</Label>
              <Input
                id="order-shipping"
                name="shipping"
                type="number"
                min={0}
                step="0.01"
                placeholder="0.00"
                value={form.shipping}
                onChange={(e) => setForm((now) => ({ ...now, shipping: e.target.value }))}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="order-tax">Tax (% of the items)</Label>
              <Input
                id="order-tax"
                name="tax"
                type="number"
                min={0}
                max={100}
                step="0.001"
                placeholder="0"
                value={form.tax}
                onChange={(e) => setForm((now) => ({ ...now, tax: e.target.value }))}
              />
            </div>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs leading-tight font-semibold">
              Anything else on the bill
            </legend>
            {form.adjustments.map((adjustment, index) => (
              <div key={index} className="grid grid-cols-[1fr_8rem] gap-2">
                <Input
                  name={`adj_label_${index}`}
                  maxLength={80}
                  placeholder="Pallet fee, discount…"
                  value={adjustment.label}
                  onChange={(e) => setAdjustment(index, { label: e.target.value })}
                  aria-label={`Adjustment ${index + 1}: what it is`}
                />
                <Input
                  name={`adj_amount_${index}`}
                  type="number"
                  step="0.01"
                  placeholder="0.00"
                  value={adjustment.amount}
                  onChange={(e) => setAdjustment(index, { amount: e.target.value })}
                  aria-label={`Adjustment ${index + 1}: amount`}
                />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              {form.adjustments.length < MAX_ADJUSTMENTS && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="print:hidden"
                  onClick={() =>
                    setForm((now) => ({
                      ...now,
                      adjustments: [...now.adjustments, { label: "", amount: "" }],
                    }))
                  }
                >
                  Add a fee or discount
                </Button>
              )}
              {form.adjustments.length > 0 && (
                <span className="text-muted-foreground text-xs">
                  Use a minus for money off. Empty a row to remove it.
                </span>
              )}
            </div>
          </fieldset>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="order-notes">Note to the supplier</Label>
            <Input id="order-notes" name="notes" maxLength={2000} defaultValue={notes} />
          </div>
        </div>

        <dl className="bg-panel flex h-fit flex-col gap-1.5 rounded-md p-3 text-sm tabular-nums">
          {totals ? (
            <>
              <div className="flex justify-between gap-3">
                <dt>Items</dt>
                <dd>{money(totals.subtotal.toNumber())}</dd>
              </div>
              {!totals.shipping.isZero() && (
                <div className="flex justify-between gap-3">
                  <dt>Shipping</dt>
                  <dd>{money(totals.shipping.toNumber())}</dd>
                </div>
              )}
              {!totals.tax.isZero() && (
                <div className="flex justify-between gap-3">
                  <dt>Tax ({form.tax}%)</dt>
                  <dd>{money(totals.tax.toNumber())}</dd>
                </div>
              )}
              {!totals.adjustmentsTotal.isZero() && (
                <div className="flex justify-between gap-3">
                  <dt>Fees and discounts</dt>
                  <dd>{money(totals.adjustmentsTotal.toNumber())}</dd>
                </div>
              )}
              <div className="border-border mt-1 flex justify-between gap-3 border-t pt-2 font-semibold">
                <dt>Total</dt>
                <dd>{money(totals.total.toNumber())}</dd>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">
              The total shows once every amount is a number.
            </p>
          )}
        </dl>
      </div>

      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit print:hidden">
        Save changes
      </SubmitButton>
    </form>
  );
}
