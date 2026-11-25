"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HelpdeskState } from "./actions";
import { forgetSocialPerson, setKnownEmail } from "./social-actions";

/**
 * An email for someone who messaged on Instagram or Facebook. Meta doesn't
 * share one, so their orders can only be found once the team writes it down
 * (ask them for it, or for their order number). Never guessed from a name.
 */
export function KnownEmail({
  slug,
  contactId,
  email,
  canEdit,
  name,
}: {
  slug: string;
  contactId: string;
  email: string | null;
  canEdit: boolean;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<HelpdeskState, FormData>(
    async (prev, formData) => {
      const result = await setKnownEmail(slug, contactId, prev, formData);
      if (!result.error) setOpen(false);
      return result;
    },
    {},
  );
  if (!open) {
    return (
      <p className="bg-sunken mt-3 rounded-md px-3 py-2 text-xs">
        {email ? (
          <>
            Orders are looked up under <span className="font-read font-semibold">{email}</span>.
          </>
        ) : (
          `${name} doesn't share an email, so we can't look up their orders. Ask for their email or order number.`
        )}{" "}
        {canEdit && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-ochre-text font-semibold hover:underline"
          >
            {email ? "Change" : "Add their email"}
          </button>
        )}
      </p>
    );
  }
  return (
    <form action={action} className="bg-sunken mt-3 flex flex-col gap-1.5 rounded-md px-3 py-2">
      <label htmlFor="known-email" className="text-xs font-semibold">
        Their email, as they gave it to you
      </label>
      <span className="flex gap-1.5">
        <input
          id="known-email"
          name="email"
          type="email"
          defaultValue={email ?? ""}
          autoComplete="off"
          placeholder="name@example.com"
          className="border-input bg-card h-8 min-w-0 flex-1 rounded-sm border px-2 text-sm"
        />
        <button
          type="submit"
          disabled={pending}
          className="bg-foreground text-background h-8 rounded-sm px-2.5 text-xs font-semibold"
        >
          {pending ? "Saving…" : "Save"}
        </button>
      </span>
      <span className="text-muted-foreground text-xs">
        Only used to find their orders. Leave it empty to remove it.{" "}
        <button type="button" onClick={() => setOpen(false)} className="underline">
          Cancel
        </button>
      </span>
      {state.error && (
        <span role="alert" className="text-brick text-xs">
          {state.error}
        </span>
      )}
    </form>
  );
}

/** Forgets someone who messaged: every conversation, message and file of theirs. Owners and admins. */
export function ForgetPerson({
  slug,
  contactId,
  back,
}: {
  slug: string;
  contactId: string;
  back: string;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <p className="mt-3 text-xs">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          if (
            !window.confirm(
              "Forget this customer? Every conversation with them here, what was said and their files are deleted for good. Messages in the Instagram or Facebook app itself aren't touched.",
            )
          ) {
            return;
          }
          start(async () => {
            const result = await forgetSocialPerson(slug, contactId);
            if (result.error) setProblem(result.error);
            else router.push(back);
          });
        }}
        className="text-muted-foreground hover:text-brick underline"
      >
        {busy ? "Forgetting…" : "Forget this customer"}
      </button>
      {problem && (
        <span role="alert" className="text-brick ml-2">
          {problem}
        </span>
      )}
    </p>
  );
}
