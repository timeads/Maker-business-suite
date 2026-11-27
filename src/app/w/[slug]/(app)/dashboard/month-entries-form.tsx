"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { formatMoney } from "@/lib/dashboard/format";
import { toCents } from "@/lib/dashboard/lines";
import { saveMonthEntries, type MoneySettingsState } from "./money-settings-actions";

export type MonthEntryRow = {
  kind: "cost" | "revenue";
  subject: string;
  name: string;
  /** The cost's usual amount a month (costs only), whole cents. */
  usual: number | null;
  /** What's typed in for this month, whole cents, or null. */
  cents: number | null;
  note: string;
};

const dollars = (cents: number | null) => (cents === null ? "" : (cents / 100).toFixed(2));

/**
 * One month's entries for profit by line: each monthly cost's real amount
 * that month (blank keeps the usual one), and revenue a line had that
 * reached neither the shop nor the books (blank for none).
 */
export function MonthEntriesForm({
  slug,
  month,
  rows,
  currency,
}: {
  slug: string;
  month: string;
  rows: readonly MonthEntryRow[];
  currency: string;
}) {
  const [state, action] = useActionState<MoneySettingsState, FormData>(
    saveMonthEntries.bind(null, slug, month),
    {},
  );
  const [values, setValues] = useState<Record<string, { amount: string; note: string }>>(() =>
    Object.fromEntries(
      rows.map((r) => [`${r.kind}:${r.subject}`, { amount: dollars(r.cents), note: r.note }]),
    ),
  );
  const bad = rows.some((r) => {
    const text = values[`${r.kind}:${r.subject}`]?.amount.trim() ?? "";
    return text !== "" && !/^\d{1,9}(\.\d{1,2})?$/.test(text);
  });
  const body = rows.map((r) => {
    const value = values[`${r.kind}:${r.subject}`] ?? { amount: "", note: "" };
    const text = value.amount.trim();
    return {
      kind: r.kind,
      subject: r.subject,
      amount_cents: text === "" ? null : toCents(text),
      note: value.note.trim(),
    };
  });
  const costs = rows.filter((r) => r.kind === "cost");
  const lines = rows.filter((r) => r.kind === "revenue");
  const field = (r: MonthEntryRow) => {
    const key = `${r.kind}:${r.subject}`;
    const value = values[key] ?? { amount: "", note: "" };
    return (
      <div key={key} className="grid gap-2 sm:grid-cols-[1fr_9rem_14rem] sm:items-end">
        <Label htmlFor={`entry-${key}`} className="font-normal">
          {r.name}
          {r.usual !== null && (
            <span className="text-muted-foreground block text-xs">
              Usually {formatMoney(r.usual / 100, currency)} a month
            </span>
          )}
        </Label>
        <Input
          id={`entry-${key}`}
          inputMode="decimal"
          placeholder={r.usual !== null ? dollars(r.usual) : "0.00"}
          value={value.amount}
          onChange={(e) => setValues({ ...values, [key]: { ...value, amount: e.target.value } })}
        />
        <Input
          aria-label={`Note for ${r.name}`}
          placeholder="A note (optional)"
          maxLength={200}
          value={value.note}
          onChange={(e) => setValues({ ...values, [key]: { ...value, note: e.target.value } })}
        />
      </div>
    );
  };
  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="body" value={JSON.stringify(body)} />
      {costs.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">What each monthly cost came to</legend>
          <p className="text-muted-foreground text-xs">
            Leave a box blank to keep the usual amount for this month.
          </p>
          {costs.map(field)}
        </fieldset>
      )}
      {lines.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-1 text-sm font-semibold">Revenue from elsewhere</legend>
          <p className="text-muted-foreground text-xs">
            Sales that reached neither your shop nor your books, such as another shop&apos;s
            payouts. Blank for none.
          </p>
          {lines.map(field)}
        </fieldset>
      )}
      {bad && <FormMessage>Amounts are in dollars and cents, like 1250 or 1250.50.</FormMessage>}
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save this month
      </SubmitButton>
    </form>
  );
}
