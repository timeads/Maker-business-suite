"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { PlanKey } from "@/lib/billing/plans";
import { openBillingPortal, startCheckout, type BillingState } from "./actions";

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
