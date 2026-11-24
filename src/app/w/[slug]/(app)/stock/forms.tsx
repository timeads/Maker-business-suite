"use client";

import { useActionState, useEffect, useRef } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  adoptLeadTime,
  archiveOrder,
  deleteDraftOrder,
  receiveDelivery,
  renameOrder,
  retryShopCount,
  saveItemCost,
  saveItemPlan,
  saveStockSettings,
  saveSupplierClosure,
  saveSupplier,
  setItemHidden,
  setItemReorder,
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

/**
 * An item's two switches, as TuftStock has them. "Don't reorder" stops the
 * suggestions and keeps the item in the lists; "Hide" also puts it out of sight.
 */
export function ReorderSwitch({
  slug,
  itemId,
  hidden,
  paused,
}: {
  slug: string;
  itemId: string;
  hidden: boolean;
  paused: boolean;
}) {
  const [hideState, hideAction] = useActionState(
    setItemHidden.bind(null, slug, itemId, !hidden),
    {},
  );
  const [pauseState, pauseAction] = useActionState(
    setItemReorder.bind(null, slug, itemId, !paused),
    {},
  );
  return (
    <div className="flex flex-col gap-4">
      <form action={pauseAction} className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-read max-w-xl text-sm">
            {paused
              ? "You've said don't reorder this one. It stays in your lists with its count, but it's never suggested or put on an order."
              : "We plan for this item: it shows up in suggestions when it runs low. Switch that off for things you won't buy again but still want to see, like a line you're selling through."}
          </p>
          <SubmitButton variant="outline" pendingText="Saving…">
            {paused ? "Reorder this again" : "Don't reorder this"}
          </SubmitButton>
        </div>
        <Result state={pauseState} />
      </form>
      <form action={hideAction} className="border-border flex flex-col gap-3 border-t pt-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="font-read max-w-xl text-sm">
            {hidden
              ? "This one is hidden: out of sight under Everything → Hidden, and out of planning."
              : "Hide it to take it out of your lists altogether, for things that were never stock: gift cards, made-to-order pieces."}
          </p>
          <SubmitButton variant="outline" pendingText="Saving…">
            {hidden ? "Unhide this" : "Hide this"}
          </SubmitButton>
        </div>
        <Result state={hideState} />
      </form>
    </div>
  );
}

/** Adds a stretch when a supplier is shut. The form clears itself once it has saved. */
export function ClosureForm({ slug, supplierId }: { slug: string; supplierId: string }) {
  const [state, action] = useActionState(saveSupplierClosure.bind(null, slug, supplierId), {});
  const id = `closure-${supplierId}`;
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>They&apos;re shut for</Label>
          <Input
            id={`${id}-name`}
            name="name"
            maxLength={80}
            placeholder="Spring Festival"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-from`}>First day shut</Label>
          <Input id={`${id}-from`} name="starts_on" type="date" required />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-to`}>Last day shut</Label>
          <Input id={`${id}-to`} name="ends_on" type="date" required />
        </div>
        <SubmitButton variant="outline" pendingText="Saving…">
          Add closure
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
  contact_name?: string | null;
  more_emails?: string[] | null;
  lead_time_days: number | null;
  coverage_days: number;
  moq: number;
  moq_applies_to: "order" | "sku";
  notes: string;
  archived: boolean;
};

/** One press to set a supplier's days-to-arrive to what their past orders really took. */
export function AdoptLeadTimeButton({
  slug,
  supplierId,
  days,
}: {
  slug: string;
  supplierId: string;
  days: number;
}) {
  const [state, action] = useActionState(adoptLeadTime.bind(null, slug, supplierId), {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <SubmitButton variant="outline" size="sm" pendingText="Saving…">
        Use the {days} days they really take
      </SubmitButton>
      <span className="text-xs" aria-live="polite">
        {state.error ? (
          <span className="text-brick">{state.error}</span>
        ) : (
          <span className="text-muted-foreground">
            {state.message ?? "Worked out from when their past orders arrived."}
          </span>
        )}
      </span>
    </form>
  );
}

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
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-contact`}>Who you deal with</Label>
          <Input
            id={`${id}-contact`}
            name="contact_name"
            maxLength={120}
            defaultValue={supplier?.contact_name ?? ""}
            placeholder="Dana Reyes"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-more`}>Other emails for orders</Label>
          <Input
            id={`${id}-more`}
            name="more_emails"
            maxLength={600}
            defaultValue={(supplier?.more_emails ?? []).join(", ")}
            placeholder="accounts@hillmill.example, …"
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
            defaultValue={supplier ? (supplier.lead_time_days ?? "") : ""}
            placeholder="Your usual"
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
          placeholder="Ask for Dana. Pays the freight on orders over 500."
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

/** The order's reference, changed in place. Tucked behind "Rename" so the page stays calm. */
export function RenameOrderForm({
  slug,
  orderId,
  reference,
}: {
  slug: string;
  orderId: string;
  reference: string;
}) {
  const [state, action] = useActionState(renameOrder.bind(null, slug, orderId), {});
  return (
    <details className="relative print:hidden">
      <summary className="border-input bg-card hover:bg-hover flex h-[30px] cursor-pointer list-none items-center rounded-sm border px-2.5 text-xs font-semibold [&::-webkit-details-marker]:hidden">
        Rename
      </summary>
      <form
        action={action}
        className="border-border bg-card absolute right-0 z-10 mt-1 flex w-72 flex-col gap-2 rounded-lg border p-3 shadow-[var(--tuft-shadow)]"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="order-reference">Call this order</Label>
          <Input
            id="order-reference"
            name="reference"
            key={reference}
            defaultValue={reference}
            minLength={3}
            maxLength={40}
            required
            className="font-mono text-sm"
          />
        </div>
        <p className="text-muted-foreground text-xs">
          It&apos;s what your supplier sees on the PDF and in the email. No two orders can share
          one.
        </p>
        <Result state={state} />
        <SubmitButton variant="outline" size="sm" pendingText="Saving…">
          Save the name
        </SubmitButton>
      </form>
    </details>
  );
}

/** "Put away" / "Bring back" for an order nothing is still expected on. */
export function ArchiveButton({
  slug,
  orderId,
  archived,
}: {
  slug: string;
  orderId: string;
  archived: boolean;
}) {
  const [state, action] = useActionState(archiveOrder.bind(null, slug, orderId, !archived), {});
  return (
    <form action={action} className="flex flex-col items-end gap-1 print:hidden">
      <SubmitButton variant="ghost" size="sm" pendingText="Saving…">
        {archived ? "Bring back from the archive" : "Put away (archive)"}
      </SubmitButton>
      {state.error && <span className="text-brick max-w-56 text-right text-xs">{state.error}</span>}
    </form>
  );
}

/** "Delete this draft", with an "are you sure?" since there is no undo. */
export function DeleteDraftButton({ slug, orderId }: { slug: string; orderId: string }) {
  const [state, action] = useActionState(deleteDraftOrder.bind(null, slug, orderId), {});
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm("Delete this draft for good? This can't be undone.")) {
          event.preventDefault();
        }
      }}
      className="flex flex-col items-end gap-1 print:hidden"
    >
      <SubmitButton variant="danger" size="sm" pendingText="Deleting…">
        Delete this draft
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
  booksConnected,
}: {
  slug: string;
  settings: {
    default_lead_time_days: number;
    default_coverage_days: number;
    review_buffer_days: number;
    seasonality: boolean;
    push_to_shop: boolean;
    skip_words: string[];
    skip_tags: string[];
    payments_from_books: boolean;
  };
  canPush: boolean;
  /** The workspace has its books connected, so payments can be read from them. */
  booksConnected: boolean;
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
      {booksConnected ? (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="payments_from_books"
            defaultChecked={settings.payments_from_books}
            className="mt-0.5"
          />
          <span>
            Read payments to my suppliers from QuickBooks
            <span className="text-muted-foreground block text-xs">
              A bill payment, cheque or card charge made out to a supplier of the same name is added
              to that supplier&apos;s account under Balances, a few times a day. Only for suppliers
              whose account you&apos;ve started, and never one you&apos;ve already typed in. Nothing
              is ever changed in your books.
            </span>
          </span>
        </label>
      ) : (
        // Not on offer here, but whatever was chosen is kept as it is.
        settings.payments_from_books && (
          <input type="hidden" name="payments_from_books" value="on" />
        )
      )}
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
          Everything → Hidden. Take a word off and they come straight back.
        </p>
      </div>
      <div className="flex flex-col gap-1.5 sm:max-w-md">
        <Label htmlFor="set-skip-tags">Never reorder anything with these tags in my shop</Label>
        <textarea
          id="set-skip-tags"
          name="skip_tags"
          rows={2}
          defaultValue={settings.skip_tags.join("\n")}
          placeholder={"made to order\ndiscontinued"}
          className={textarea}
        />
        <p className="text-muted-foreground text-xs">
          One per line, the whole tag as your shop has it (capitals don&apos;t matter). Tags are
          read with each sync, so a product you tag today is left out after the next one.
        </p>
      </div>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save settings
      </SubmitButton>
    </form>
  );
}
