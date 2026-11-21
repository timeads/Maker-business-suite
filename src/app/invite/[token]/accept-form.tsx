"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { acceptInvite, type AcceptState } from "./actions";

export function AcceptForm({ token, workspaceName }: { token: string; workspaceName: string }) {
  const [state, action] = useActionState<AcceptState, FormData>(acceptInvite.bind(null, token), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton pendingText="Joining…">Join {workspaceName}</SubmitButton>
    </form>
  );
}
