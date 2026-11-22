"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { PlanKey } from "@/lib/billing/plans";
import { chooseModule, openBillingPortal, startCheckout, type BillingState } from "./actions";

export function ChoosePlanButton({
  slug,
  plan,
  label,
  highlighted,
}: {
  slug: string;
  plan: PlanKey;
  label: string;
  highlighted: boolean;
}) {
  const [state, action] = useActionState<BillingState, FormData>(
    startCheckout.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="plan" value={plan} />
      <SubmitButton
        variant={highlighted ? "default" : "outline"}
        pendingText="One moment…"
        className="w-full"
      >
        {label}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

export function ManageBillingButton({ slug, label }: { slug: string; label: string }) {
  const [state, action] = useActionState<BillingState, FormData>(
    openBillingPortal.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2 sm:w-fit">
      <SubmitButton pendingText="One moment…">{label}</SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

export function ModuleChoiceForm({
  slug,
  options,
  chosen,
}: {
  slug: string;
  options: { key: string; name: string; blurb: string; available: boolean }[];
  chosen: string[];
}) {
  const [state, action] = useActionState<BillingState, FormData>(chooseModule.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Your extra tool</legend>
        {options.map((option) => (
          <label key={option.key} className="flex items-start gap-3 text-sm">
            <input
              type="radio"
              name="module"
              value={option.key}
              defaultChecked={chosen.includes(option.key)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{option.name}</span>
              {!option.available && <span className="text-muted-foreground"> (coming soon)</span>}
              <span className="text-muted-foreground block">{option.blurb}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save choice
      </SubmitButton>
    </form>
  );
}
