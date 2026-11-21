"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { WorkspaceFields } from "@/components/workspace-fields";
import { createWorkspace, type OnboardingState } from "./actions";

export function OnboardingForm(props: {
  timezones: string[];
  currencies: { code: string; label: string }[];
}) {
  const [state, action] = useActionState<OnboardingState, FormData>(createWorkspace, {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <WorkspaceFields {...props} />
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton pendingText="Setting things up…">Create workspace</SubmitButton>
    </form>
  );
}
