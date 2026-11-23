"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { createEmail, type EmailState } from "../../../emails/actions";

/** Pick a starter; the email opens in the builder straight away. */
export function NewEmail({
  slug,
  starters,
}: {
  slug: string;
  starters: { id: string; name: string; about: string }[];
}) {
  const [state, action] = useActionState<EmailState, FormData>(createEmail.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <fieldset className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <legend className="sr-only">Start from</legend>
        {starters.map((starter, index) => (
          <label
            key={starter.id}
            className="bg-card hover:bg-hover has-checked:border-teal has-checked:ring-teal flex cursor-pointer flex-col gap-1 rounded-lg border p-3 has-checked:ring-1"
          >
            <span className="flex items-center gap-2 text-sm font-semibold">
              <input type="radio" name="template" value={starter.id} defaultChecked={index === 0} />
              {starter.name}
            </span>
            <span className="text-muted-foreground text-xs">{starter.about}</span>
          </label>
        ))}
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton pendingText="Opening…" className="sm:w-fit">
        Start this email
      </SubmitButton>
    </form>
  );
}
