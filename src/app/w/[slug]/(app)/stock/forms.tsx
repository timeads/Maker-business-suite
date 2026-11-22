"use client";

import { useActionState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  assignSupplier,
  receiveDelivery,
  saveItemPlan,
  saveOrder,
  saveStockSettings,
  saveSupplier,
  setOrderStatus,
  startEmptyOrder,
  type StockState,
} from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

function Result({ state }: { state: StockState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export function PrintButton() {
  return (
    <Button variant="outline" size="sm" className="print:hidden" onClick={() => window.print()}>
      <Printer /> Print
    </Button>
  );
}

type Option = { id: string; name: string };

export type SupplierValues = {
  id: string;
  name: string;
  email: string | null;
  lead_time_days: number;
  coverage_days: number;
  moq: number;
  moq_applies_to: "order" | "sku";
  notes: string;
  archived: boolean;
};

export function SupplierForm({ slug, supplier }: { slug: string; supplier?: SupplierValues }) {
  const [state, action] = useActionState(saveSupplier.bind(null, slug, supplier?.id ?? null), {});
  const id = supplier?.id ?? "new";
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Name</Label>
          <Input
            id={`${id}-name`}
            name="name"
            maxLength={120}
            defaultValue={supplier?.name}
            placeholder="Hill Mill Yarns"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-email`}>Where orders go (email)</Label>
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            maxLength={200}
            defaultValue={supplier?.email ?? ""}
          />
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-lead`}>Days to arrive</Label>
          <Input
            id={`${id}-lead`}
            name="lead"
            type="number"
            min={0}
            max={365}
            defaultValue={supplier?.lead_time_days ?? 30}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-cover`}>Each order covers (days)</Label>
          <Input
            id={`${id}-cover`}
            name="cover"
            type="number"
            min={1}
            max={365}
            defaultValue={supplier?.coverage_days ?? 30}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-moq`}>Smallest order</Label>
          <Input
            id={`${id}-moq`}
            name="moq"
            type="number"
            min={1}
            defaultValue={supplier?.moq ?? 1}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-applies`}>Counted</Label>
          <Select
            id={`${id}-applies`}
            name="moq_applies_to"
            defaultValue={supplier?.moq_applies_to ?? "order"}
          >
            <option value="order">Across the order</option>
            <option value="sku">Per item</option>
          </Select>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-notes`}>Notes</Label>
        <textarea
          id={`${id}-notes`}
          name="notes"
          rows={2}
          maxLength={2000}
          defaultValue={supplier?.notes}
          placeholder="Closed in August. Ask for Dana."
          className={textarea}
        />
      </div>
      {supplier && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="archived" defaultChecked={supplier.archived} />
          We don&apos;t order from them any more
        </label>
      )}
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        {supplier ? "Save" : "Add supplier"}
      </SubmitButton>
    </form>
  );
}

/** Sits above the items table; the table's tick boxes belong to this form. */
export function AssignBar({ slug, suppliers }: { slug: string; suppliers: Option[] }) {
  const [state, action] = useActionState(assignSupplier.bind(null, slug), {});
  return (
    <form id="assign" action={action} className="flex flex-wrap items-end gap-2 print:hidden">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="assign-supplier">Give the ticked items to</Label>
        <Select id="assign-supplier" name="supplier" defaultValue="" className="w-56">
          <option value="">No supplier</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton variant="outline" pendingText="Saving…">
        Apply
      </SubmitButton>
      <div className="basis-full">
        <Result state={state} />
      </div>
    </form>
  );
}

export function ItemPlanForm({
  slug,
  itemId,
  suppliers,
  values,
  fallback,
}: {
  slug: string;
  itemId: string;
  suppliers: Option[];
  values: {
    supplier_id: string | null;
    lead_time_days: number | null;
    coverage_days: number | null;
    safety_stock: number;
    hidden: boolean;
  };
  /** What's used when the boxes are left empty. */
  fallback: { lead: number; cover: number };
}) {
  const [state, action] = useActionState(saveItemPlan.bind(null, slug, itemId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5 sm:max-w-xs">
        <Label htmlFor="plan-supplier">Supplier</Label>
        <Select id="plan-supplier" name="supplier" defaultValue={values.supplier_id ?? ""}>
          <option value="">No supplier</option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-lead">Days to arrive</Label>
          <Input
            id="plan-lead"
            name="lead"
            type="number"
            min={0}
            max={365}
            defaultValue={values.lead_time_days ?? ""}
            placeholder={String(fallback.lead)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-cover">Each order covers (days)</Label>
          <Input
            id="plan-cover"
            name="cover"
            type="number"
            min={1}
            max={365}
            defaultValue={values.coverage_days ?? ""}
            placeholder={String(fallback.cover)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-safety">Always keep spare</Label>
          <Input
            id="plan-safety"
            name="safety"
            type="number"
            min={0}
            defaultValue={values.safety_stock}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        Leave the first two empty to use the supplier&apos;s own numbers.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="hidden" defaultChecked={values.hidden} />
        Don&apos;t plan for this one (made to order, discontinued, a gift card…)
      </label>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

export function NewOrderForm({ slug, suppliers }: { slug: string; suppliers: Option[] }) {
  const [state, action] = useActionState(startEmptyOrder.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-order-supplier">Start an order for</Label>
        <Select id="new-order-supplier" name="supplier" defaultValue="" className="w-56" required>
          <option value="" disabled>
            Pick a supplier…
          </option>
          {suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </div>
      <SubmitButton variant="outline" pendingText="Starting…">
        Start order
      </SubmitButton>
      <div className="basis-full">
        <FormMessage>{state.error}</FormMessage>
      </div>
    </form>
  );
}

export type OrderLine = {
  id: string;
  stock_item_id: string;
  name: string;
  sku: string | null;
  qty_ordered: number;
  qty_received: number;
  unit_cost: number;
};

/** A draft: every quantity and cost can still change, and items can be added. */
export function DraftOrderForm({
  slug,
  orderId,
  lines,
  notes,
  expected,
  addable,
  currency,
}: {
  slug: string;
  orderId: string;
  lines: OrderLine[];
  notes: string;
  expected: string | null;
  addable: (Option & { cost: number })[];
  currency: string;
}) {
  const [state, action] = useActionState(saveOrder.bind(null, slug, orderId), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      {lines.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead className="text-muted-foreground text-xs">
              <tr>
                <th className="py-2 pr-3 font-semibold">Item</th>
                <th className="w-28 py-2 pr-3 font-semibold">How many</th>
                <th className="w-32 py-2 font-semibold">Cost each ({currency})</th>
              </tr>
            </thead>
            <tbody className="divide-border divide-y">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2 pr-3">
                    <span className="font-read">{line.name}</span>
                    {line.sku && (
                      <span className="text-muted-foreground block text-xs">{line.sku}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    <Input
                      name={`qty_${line.stock_item_id}`}
                      type="number"
                      min={0}
                      defaultValue={line.qty_ordered}
                      aria-label={`How many ${line.name}`}
                    />
                  </td>
                  <td className="py-2">
                    <Input
                      name={`cost_${line.stock_item_id}`}
                      type="number"
                      min={0}
                      step="0.01"
                      defaultValue={line.unit_cost.toFixed(2)}
                      aria-label={`Cost of each ${line.name}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-muted-foreground mt-1 text-xs">Set a line to 0 to take it off.</p>
        </div>
      )}
      {addable.length > 0 && (
        <div className="bg-panel grid gap-3 rounded-md p-3 sm:grid-cols-[1fr_7rem_8rem]">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-item">Add an item</Label>
            <Select id="add-item" name="add_item" defaultValue="">
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
            <Input id="add-qty" name="add_qty" type="number" min={1} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="add-cost">Cost each</Label>
            <Input id="add-cost" name="add_cost" type="number" min={0} step="0.01" />
          </div>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[12rem_1fr]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-expected">Expected to arrive</Label>
          <Input id="order-expected" name="expected" type="date" defaultValue={expected ?? ""} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-notes">Note to the supplier</Label>
          <Input id="order-notes" name="notes" maxLength={2000} defaultValue={notes} />
        </div>
      </div>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit print:hidden">
        Save changes
      </SubmitButton>
    </form>
  );
}

export function StatusButton({
  slug,
  orderId,
  to,
  label,
  pending,
  variant = "outline",
}: {
  slug: string;
  orderId: string;
  to: "ordered" | "closed" | "cancelled" | "draft";
  label: string;
  pending: string;
  variant?: "default" | "outline" | "ghost" | "danger";
}) {
  const [state, action] = useActionState(setOrderStatus.bind(null, slug, orderId, to), {});
  return (
    <form action={action} className="flex flex-col items-end gap-1 print:hidden">
      <SubmitButton variant={variant} size="sm" pendingText={pending}>
        {label}
      </SubmitButton>
      {state.error && <span className="text-brick max-w-56 text-right text-xs">{state.error}</span>}
    </form>
  );
}

/** Checking a delivery in: a box per line, filled in with what's still to come. */
export function ReceiveForm({
  slug,
  orderId,
  lines,
  pushOffered,
  pushDefault,
}: {
  slug: string;
  orderId: string;
  lines: OrderLine[];
  /** The shop will take additions to its count. */
  pushOffered: boolean;
  pushDefault: boolean;
}) {
  const [state, action] = useActionState(receiveDelivery.bind(null, slug, orderId), {});
  const waiting = lines.filter((line) => line.qty_received < line.qty_ordered);
  return (
    <form action={action} className="flex flex-col gap-3">
      <ul className="divide-border flex flex-col divide-y">
        {waiting.map((line) => (
          <li key={line.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2">
            <span className="min-w-0 flex-1 basis-48">
              <span className="font-read text-sm">{line.name}</span>
              <span className="text-muted-foreground block text-xs tabular-nums">
                {line.qty_received} of {line.qty_ordered} here so far
              </span>
            </span>
            <span className="flex items-center gap-2 text-sm">
              <Label htmlFor={`got-${line.id}`}>Arrived</Label>
              <Input
                id={`got-${line.id}`}
                name={`got_${line.id}`}
                type="number"
                min={0}
                defaultValue={line.qty_ordered - line.qty_received}
                className="w-24"
              />
            </span>
          </li>
        ))}
      </ul>
      {pushOffered && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="push" defaultChecked={pushDefault} />
          Add these to my shop&apos;s count as well
        </label>
      )}
      <Result state={state} />
      {/* The one filled button: checking stock in is what this page is for. */}
      <SubmitButton pendingText="Checking in…" className="sm:w-fit">
        Check these in
      </SubmitButton>
    </form>
  );
}

export function StockSettingsForm({
  slug,
  settings,
  canPush,
}: {
  slug: string;
  settings: {
    default_lead_time_days: number;
    default_coverage_days: number;
    review_buffer_days: number;
    seasonality: boolean;
    push_to_shop: boolean;
  };
  canPush: boolean;
}) {
  const [state, action] = useActionState(saveStockSettings.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="set-lead">Days to arrive</Label>
          <Input
            id="set-lead"
            name="lead"
            type="number"
            min={0}
            max={365}
            defaultValue={settings.default_lead_time_days}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="set-cover">Each order covers (days)</Label>
          <Input
            id="set-cover"
            name="cover"
            type="number"
            min={1}
            max={365}
            defaultValue={settings.default_coverage_days}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="set-review">I place orders every (days)</Label>
          <Input
            id="set-review"
            name="review"
            type="number"
            min={0}
            max={60}
            defaultValue={settings.review_buffer_days}
            required
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        The first two are used for anything whose supplier doesn&apos;t have its own. The third
        gives you that much warning before something needs ordering.
      </p>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="seasonality"
          defaultChecked={settings.seasonality}
          className="mt-1"
        />
        <span>
          Plan ahead for busy seasons
          <span className="text-muted-foreground block text-xs">
            If the same months are busy year after year, order more ahead of them. Needs about a
            year of sales to show.
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="push_to_shop"
          defaultChecked={settings.push_to_shop && canPush}
          disabled={!canPush}
          className="mt-1"
        />
        <span>
          Add deliveries to my shop&apos;s count when I check them in
          <span className="text-muted-foreground block text-xs">
            {canPush
              ? "It only ever adds what arrived. Nothing else in your shop is changed."
              : "Your shop hasn't given permission for this yet. Until it does, update the count in your shop yourself."}
          </span>
        </span>
      </label>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save settings
      </SubmitButton>
    </form>
  );
}
