"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { joinWorkspace, type JoinState } from "./actions";

export function JoinForm({ inviteId, workspaceName }: { inviteId: string; workspaceName: string }) {
  const [state, action] = useActionState<JoinState, FormData>(
    joinWorkspace.bind(null, inviteId),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <SubmitButton pendingText="Joining…" className="sm:w-fit">
        Join {workspaceName}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}
