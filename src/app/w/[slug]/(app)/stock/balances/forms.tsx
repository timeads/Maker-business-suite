"use client";

import { useActionState, useOptimistic, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import type { StockState } from "../actions";
import { addLedgerEntry, markBillPaid, removeLedgerEntry, setSupplierTerms } from "./actions";

type Kind = "invoice" | "payment" | "statement" | "credit";

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  {
    kind: "invoice",
    label: "Invoice",
    hint: "A bill from the supplier. Use the date printed on it: the days you have to pay count from then.",
  },
  { kind: "payment", label: "Payment", hint: "Money you sent them, however you sent it." },
  {
    kind: "statement",
    label: "Statement balance",
    hint: "What the supplier's own statement says you owe on that date. It takes over from everything dated before it.",
  },
  { kind: "credit", label: "Credit", hint: "A credit note or refund that lowers what you owe." },
];

/** Adds an invoice, payment, statement balance or credit to one supplier's account. */
export function EntryForm({
  slug,
  supplierId,
  today,
}: {
  slug: string;
  supplierId: string;
  /** The workspace's calendar day, YYYY-MM-DD. */
  today: string;
}) {
  const [kind, setKind] = useState<Kind>("invoice");
  const [date, setDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  // The boxes are kept here so a refused entry isn't wiped; a saved one clears
  // them, but leaves the kind and date for the next one in the pile.
  const [state, action] = useActionState(async (prev: StockState, formData: FormData) => {
    const result = await addLedgerEntry(slug, supplierId, prev, formData);
    if (!result.error) {
      setAmount("");
      setReference("");
      setNote("");
    }
    return result;
  }, {});
  const hint = KINDS.find((k) => k.kind === kind)?.hint;

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="kind" value={kind} />
      <div>
        <div
          role="radiogroup"
          aria-label="What are you adding?"
          className="border-input bg-card inline-flex flex-wrap gap-0.5 rounded-sm border p-0.5"
        >
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              onClick={() => setKind(k.kind)}
              className={cn(
                "focus-visible:ring-ring rounded-[5px] px-3 py-1 text-sm outline-none focus-visible:ring-2",
                kind === k.kind
                  ? "bg-teal text-on-teal font-semibold"
                  : "text-text-2 hover:bg-hover",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="text-muted-foreground mt-1.5 text-xs">{hint}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entry-date">Date</Label>
          <Input
            id="entry-date"
            name="date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entry-amount">
            {kind === "statement" ? "Balance (use a minus sign if it's a credit)" : "Amount"}
          </Label>
          <Input
            id="entry-amount"
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            maxLength={20}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entry-reference">
            {kind === "invoice"
              ? "Invoice #"
              : kind === "payment"
                ? "Payment reference (optional)"
                : "Reference (optional)"}
          </Label>
          <Input
            id="entry-reference"
            name="reference"
            maxLength={80}
            autoComplete="off"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="entry-note">Note (optional)</Label>
          <Input
            id="entry-note"
            name="note"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      {kind === "invoice" && (
        <p className="text-muted-foreground text-xs">
          Typed an amount wrong? Add the invoice again with the same number and it&apos;s corrected,
          not counted twice.
        </p>
      )}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      {/* The one filled button: writing things down is what this page is for. */}
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Add to the account
      </SubmitButton>
    </form>
  );
}

export function TermsForm({
  slug,
  supplierId,
  days,
}: {
  slug: string;
  supplierId: string;
  days: number;
}) {
  const [state, action] = useActionState(setSupplierTerms.bind(null, slug, supplierId), {});
  return (
    <form action={action} className="flex flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="terms-days">Days to pay after the invoice date</Label>
        <Input
          id="terms-days"
          name="days"
          type="number"
          min={0}
          max={365}
          defaultValue={days}
          className="w-28"
          required
        />
      </div>
      <SubmitButton variant="outline" pendingText="Saving…">
        Save
      </SubmitButton>
      <div className="basis-full">
        <FormMessage>{state.error}</FormMessage>
        <FormMessage kind="success">{state.message}</FormMessage>
      </div>
    </form>
  );
}

/**
 * The "Paid" tick on an open bill: a note that the money has been sent. The
 * balance doesn't move until the payment itself is added to the account.
 */
export function PaidTick({
  slug,
  entryId,
  checked,
  label,
  disabled = false,
}: {
  slug: string;
  entryId: string;
  checked: boolean;
  label: string;
  disabled?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  // Shows the tick straight away; it falls back to the saved value if the save fails.
  const [shown, setShown] = useOptimistic(checked);
  return (
    <span className="flex flex-col gap-0.5">
      <label
        className="inline-flex w-fit items-center gap-1.5 text-xs"
        title="Tick once you've sent the money"
      >
        <input
          type="checkbox"
          checked={shown}
          disabled={disabled || pending}
          aria-label={label}
          onChange={(e) => {
            const next = e.target.checked;
            start(async () => {
              setShown(next);
              const result = await markBillPaid(slug, entryId, next);
              setError(result.error);
            });
          }}
        />
        Paid
      </label>
      {error && (
        <span role="alert" className="text-brick text-xs">
          {error}
        </span>
      )}
    </span>
  );
}

/** Takes one entry off the account, after asking. */
export function RemoveEntryButton({
  slug,
  entryId,
  what,
}: {
  slug: string;
  entryId: string;
  /** "the invoice KRD-104", for the question and the screen reader. */
  what: string;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <span className="flex flex-col items-end gap-0.5">
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={pending}
        aria-label={`Remove ${what}`}
        onClick={() => {
          if (!window.confirm(`Remove ${what} from this account? The balance will change.`)) return;
          start(async () => {
            const result = await removeLedgerEntry(slug, entryId);
            setError(result.error);
          });
        }}
      >
        {pending ? "Removing…" : "Remove"}
      </Button>
      {error && (
        <span role="alert" className="text-brick max-w-40 text-right text-xs">
          {error}
        </span>
      )}
    </span>
  );
}
