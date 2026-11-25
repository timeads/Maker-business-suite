"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";

type State = { error?: string; message?: string };

/** Sends the person to Google to connect Gmail with reading asked for. */
export function ConnectReadingForm({
  action,
  access,
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  access: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="access" value={access} />
      <SubmitButton variant="outline" pendingText="Opening Google…" className="w-fit">
        Connect Gmail with reading
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}
