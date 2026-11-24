"use client";

import { useActionState, useEffect, useRef } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  receiveDelivery,
  retryShopCount,
  saveItemCost,
  saveItemPlan,
  saveStockSettings,
  saveSupplier,
  setItemHidden,
  setOrderStatus,
  startEmptyOrder,
  type StockState,
} from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

export function Result({ state }: { state: StockState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

/**
 * A hidden key sent with the form, so pressing the button twice can't make two
 * orders: both presses carry the same key and the second finds the first's
 * work. A fresh key is made whenever `resetOn` changes (a different selection)
 * and after the form clears itself.
 */
export function RequestKey({ resetOn = "" }: { resetOn?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.value = crypto.randomUUID();
    const form = input.form;
    const again = () =>
      window.setTimeout(() => {
        input.value = crypto.randomUUID();
      }, 0);
    form?.addEventListener("reset", again);
    return () => form?.removeEventListener("reset", again);
  }, [resetOn]);
  return <input ref={ref} type="hidden" name="request_key" defaultValue="" />;
}

/** The button on a suggested order; it greys out while the order is being drafted. */
export function StartOrderButton() {
  return (
    <>
      <RequestKey />
      <SubmitButton variant="outline" size="sm" pendingText="Drafting…">
        Start this order
      </SubmitButton>
    </>
  );
}

/** The "Don't reorder" switch for one item: says where it stands, and flips it. */
export function ReorderSwitch({
  slug,
  itemId,
  hidden,
}: {
  slug: string;
  itemId: string;
  hidden: boolean;
}) {
  const [state, action] = useActionState(setItemHidden.bind(null, slug, itemId, !hidden), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-read max-w-xl text-sm">
          {hidden
            ? "You've said don't reorder this one. It's left out of suggestions and never put on an order."
            : "We plan for this item: it shows up in suggestions when it runs low. Switch it off for things you won't buy again, like gift cards or made-to-order pieces."}
        </p>
        <SubmitButton variant="outline" pendingText="Saving…">
          {hidden ? "Reorder this again" : "Don't reorder this"}
        </SubmitButton>
      </div>
      <Result state={state} />
    </form>
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
    case_pack?: number | null;
    moq?: number | null;
    supplier_sku?: string | null;
  };
  /** What's used when the boxes are left empty. */
  fallback: { lead: number; cover: number; moq: number };
}) {
  const [state, action] = useActionState(saveItemPlan.bind(null, slug, itemId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-ssku">What the supplier calls it</Label>
          <Input
            id="plan-ssku"
            name="supplier_sku"
            maxLength={120}
            defaultValue={values.supplier_sku ?? ""}
            placeholder="Their code, if they have one"
          />
        </div>
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
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-case">How many in a case</Label>
          <Input
            id="plan-case"
            name="case_pack"
            type="number"
            min={1}
            max={100000}
            defaultValue={values.case_pack ?? ""}
            placeholder="Bought one at a time"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="plan-moq">Smallest order of this item</Label>
          <Input
            id="plan-moq"
            name="moq"
            type="number"
            min={1}
            defaultValue={values.moq ?? ""}
            placeholder={fallback.moq > 1 ? String(fallback.moq) : "No minimum"}
          />
        </div>
      </div>
      <p className="text-muted-foreground text-xs">
        With a case size, we always suggest whole cases, rounded up. A smallest order here is used
        for this item instead of the supplier&apos;s.
      </p>
      {/* The "Don't reorder" switch has its own card; saving here keeps it as it is. */}
      {values.hidden && <input type="hidden" name="hidden" value="on" />}
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

/** Your own cost for one item. Empty means "use the usual figure". */
export function ItemCostForm({
  slug,
  itemId,
  ownCost,
  usual,
}: {
  slug: string;
  itemId: string;
  /** "12.50", or null when no figure has been typed. */
  ownCost: string | null;
  /** What's used when the box is empty, as "12.50"; null when there's nothing. */
  usual: string | null;
}) {
  const [state, action] = useActionState(saveItemCost.bind(null, slug, itemId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="own-cost">Your own cost for one</Label>
          <Input
            id="own-cost"
            name="own_cost"
            inputMode="decimal"
            maxLength={14}
            defaultValue={ownCost ?? ""}
            placeholder={usual ?? "Not set"}
            className="w-40"
          />
        </div>
        <SubmitButton variant="outline" pendingText="Saving…">
          Save
        </SubmitButton>
      </div>
      <p className="text-muted-foreground text-xs">
        Use this when you know better than the numbers do, say a new price your supplier has just
        quoted. Leave it empty to go back to the usual figure.
      </p>
      <Result state={state} />
    </form>
  );
}

export function NewOrderForm({ slug, suppliers }: { slug: string; suppliers: Option[] }) {
  const [state, action] = useActionState(startEmptyOrder.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <RequestKey />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="new-order-supplier">Start an empty order for</Label>
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
  supplier_sku: string | null;
  note: string;
  /** Units to a case, when the item is bought by the case. */
  case_pack: number | null;
};

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
      {/* One key per delivery: a second press finds the first, and a new key
          is made once what's arrived has changed. */}
      <RequestKey resetOn={lines.map((line) => `${line.id}:${line.qty_received}`).join(",")} />
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

/** "Try the shop again" beside a delivery the shop turned down. */
export function RetryShopButton({ slug, receiptId }: { slug: string; receiptId: string }) {
  const [state, action] = useActionState(retryShopCount.bind(null, slug, receiptId), {});
  return (
    <form action={action} className="mt-1 flex flex-wrap items-center gap-2">
      <SubmitButton variant="outline" size="sm" pendingText="Asking…">
        Try the shop again
      </SubmitButton>
      <span className="text-xs" aria-live="polite">
        {state.error ? (
          <span className="text-brick">{state.error}</span>
        ) : (
          <span className="text-muted-foreground">
            {state.message ?? "It only adds these units, and only once."}
          </span>
        )}
      </span>
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
    skip_words: string[];
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
      <div className="flex flex-col gap-1.5 sm:max-w-md">
        <Label htmlFor="set-skip">Never reorder anything with these words in its name</Label>
        <textarea
          id="set-skip"
          name="skip_words"
          rows={3}
          defaultValue={settings.skip_words.join("\n")}
          placeholder={"gift card\nsample"}
          className={textarea}
        />
        <p className="text-muted-foreground text-xs">
          One per line. Matching items are left out of suggestions and orders, and listed under
          Everything → Not reordering. Take a word off and they come straight back.
        </p>
      </div>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save settings
      </SubmitButton>
    </form>
  );
}
