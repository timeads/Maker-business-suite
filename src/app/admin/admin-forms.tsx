"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { endPlanGrant, requeueSync, setPlanGrant, type AdminState } from "./actions";

function Outcome({ state }: { state: AdminState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.done}</FormMessage>
    </>
  );
}

export function PlanGrantForm({
  tenantId,
  plans,
  current,
}: {
  tenantId: string;
  plans: { key: string; name: string }[];
  current: { plan: string; endsOn: string } | null;
}) {
  const [state, action] = useActionState<AdminState, FormData>(
    setPlanGrant.bind(null, tenantId),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor="grant-plan">Plan</Label>
          <Select id="grant-plan" name="plan" defaultValue={current?.plan ?? "growth"} required>
            {plans.map((plan) => (
              <option key={plan.key} value={plan.key}>
                {plan.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="grant-ends">Ends on (optional)</Label>
          <Input id="grant-ends" name="ends_on" type="date" defaultValue={current?.endsOn ?? ""} />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="grant-note">Why (kept in the record below)</Label>
        <Input
          id="grant-note"
          name="note"
          required
          maxLength={500}
          placeholder="Our own shop, a thank-you month, a longer trial…"
        />
      </div>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        {current ? "Change internal plan" : "Give internal plan"}
      </SubmitButton>
      <Outcome state={state} />
    </form>
  );
}

export function EndGrantForm({ tenantId, name }: { tenantId: string; name: string }) {
  const [state, action] = useActionState<AdminState, FormData>(
    endPlanGrant.bind(null, tenantId),
    {},
  );
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (
          !window.confirm(
            `End the internal plan for ${name} now? It goes back to whatever its Stripe subscription says.`,
          )
        ) {
          event.preventDefault();
        }
      }}
      className="border-border flex flex-col gap-3 border-t pt-4"
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="end-note">End it early: why?</Label>
        <Input id="end-note" name="note" required maxLength={500} />
      </div>
      <SubmitButton
        variant="danger"
        pendingText="Ending…"
        className="border-brick/30 border sm:w-fit"
      >
        End internal plan now
      </SubmitButton>
      <Outcome state={state} />
    </form>
  );
}

export function RequeueSyncButton({
  tenantId,
  connectionId,
  provider,
}: {
  tenantId: string;
  connectionId: string;
  provider: string;
}) {
  const [state, action] = useActionState<AdminState, FormData>(
    requeueSync.bind(null, tenantId, connectionId),
    {},
  );
  return (
    <form
      action={action}
      onSubmit={(event) => {
        if (!window.confirm(`Queue a fresh ${provider} sync for this workspace?`)) {
          event.preventDefault();
        }
      }}
      className="flex flex-col gap-2"
    >
      <SubmitButton variant="outline" size="sm" pendingText="Queuing…" className="w-fit">
        Sync again
      </SubmitButton>
      <Outcome state={state} />
    </form>
  );
}
