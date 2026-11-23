"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { createEmail, writeEmailWithClaude, type EmailState } from "../../../emails/actions";

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

/** Describe the email; Claude writes a first draft in your voice and it opens in the builder. */
export function WriteWithClaude({ slug }: { slug: string }) {
  const [state, action] = useActionState<EmailState, FormData>(
    writeEmailWithClaude.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5">
        <span className="text-xs leading-tight font-semibold">What is this email about?</span>
        <textarea
          name="ask"
          rows={3}
          required
          minLength={8}
          maxLength={2000}
          placeholder="Six new autumn rugs are in the shop. 15% off this weekend with the code LEAVES."
          className="border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
        />
        <span className="text-muted-foreground text-xs">
          Give the facts: dates, prices, codes. Claude won&rsquo;t make them up; anything missing is
          left as a gap [like this] for you to fill in.
        </span>
      </label>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="dark" pendingText="Claude is writing…" className="sm:w-fit">
        Write a first draft
      </SubmitButton>
    </form>
  );
}
