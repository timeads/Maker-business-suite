"use client";

import { useActionState } from "react";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveDebtBasics, type DebtActionState } from "../debt-actions";

/** One debt's rate, minimum and usual payment, in a row (owners and admins). */
export function DebtBasicsForm({
  slug,
  debtId,
  name,
  values,
}: {
  slug: string;
  debtId: string;
  name: string;
  values: { rate: string; minimum: string; payment: string };
}) {
  const [state, action] = useActionState<DebtActionState, FormData>(
    saveDebtBasics.bind(null, slug, debtId),
    {},
  );
  const id = (field: string) => `basics-${debtId}-${field}`;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={id("rate")}>Rate %</Label>
        <Input
          id={id("rate")}
          name="rate"
          inputMode="decimal"
          className="w-24"
          placeholder="22.99"
          defaultValue={values.rate}
          aria-label={`Rate for ${name}`}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={id("minimum")}>Minimum a month</Label>
        <Input
          id={id("minimum")}
          name="minimum"
          inputMode="decimal"
          className="w-32"
          defaultValue={values.minimum}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={id("payment")}>Usual payment</Label>
        <Input
          id={id("payment")}
          name="payment"
          inputMode="decimal"
          className="w-32"
          placeholder="If more than the minimum"
          defaultValue={values.payment}
        />
      </div>
      <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="mb-0.5">
        Save
      </SubmitButton>
      {state.error && (
        <span role="alert" className="text-brick text-xs">
          {state.error}
        </span>
      )}
      {state.message && (
        <span role="status" className="text-muted-foreground text-xs">
          {state.message}
        </span>
      )}
    </form>
  );
}
