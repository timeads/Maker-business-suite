"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { clearUnsureLabel, finishLabel } from "./label-actions";

/** "Finish recording" for a label that was paid for but isn't a parcel yet. */
export function FinishLabelButton({
  slug,
  quoteId,
  unsure,
  via = "EasyPost",
}: {
  slug: string;
  quoteId: string;
  /** We never heard back from where it was being bought, so the first step is to ask. */
  unsure: boolean;
  /** Who is asked: "EasyPost". */
  via?: string;
}) {
  const [state, action] = useActionState(finishLabel.bind(null, slug, quoteId), {});
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <SubmitButton
        variant="outline"
        size="sm"
        pendingText={unsure ? `Asking ${via}…` : "Recording…"}
      >
        {unsure ? "Check this label" : "Finish recording"}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}

/**
 * For a purchase at UPS or Redo we never heard back about. Neither can be
 * asked from here, so an owner or admin looks in that account, then clears it.
 */
export function ClearUnsureLabelButton({
  slug,
  quoteId,
  via,
}: {
  slug: string;
  quoteId: string;
  /** "UPS" or "Redo". */
  via: string;
}) {
  const [state, action] = useActionState(clearUnsureLabel.bind(null, slug, quoteId), {});
  return (
    <form
      action={action}
      className="flex flex-col items-start gap-2"
      onSubmit={(event) => {
        if (
          !window.confirm(
            `Have you looked in your ${via} account? Clearing this doesn't cancel anything there. If a label was bought, void it in ${via} or record the parcel by hand first.`,
          )
        ) {
          event.preventDefault();
        }
      }}
    >
      <SubmitButton variant="outline" size="sm" pendingText="Clearing…">
        I&apos;ve checked {via}: clear this
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
