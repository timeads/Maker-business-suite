"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { finishLabel } from "./label-actions";

/** "Finish recording" for a label that was paid for but isn't a parcel yet. */
export function FinishLabelButton({
  slug,
  quoteId,
  unsure,
}: {
  slug: string;
  quoteId: string;
  /** We never heard back from EasyPost, so the first step is to ask. */
  unsure: boolean;
}) {
  const [state, action] = useActionState(finishLabel.bind(null, slug, quoteId), {});
  return (
    <form action={action} className="flex flex-col items-start gap-2">
      <SubmitButton
        variant="outline"
        size="sm"
        pendingText={unsure ? "Asking EasyPost…" : "Recording…"}
      >
        {unsure ? "Check this label" : "Finish recording"}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
