"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { WorkspaceFields } from "@/components/workspace-fields";
import { updateWorkspace, type SettingsState } from "./actions";

export function WorkspaceForm({
  slug,
  canEdit,
  defaults,
  timezones,
  currencies,
}: {
  slug: string;
  canEdit: boolean;
  defaults: { name: string; timezone: string; currency: string };
  timezones: string[];
  currencies: { code: string; label: string }[];
}) {
  const [state, action] = useActionState<SettingsState, FormData>(
    updateWorkspace.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-4">
      <WorkspaceFields
        timezones={timezones}
        currencies={currencies}
        defaults={defaults}
        disabled={!canEdit}
      />
      <FormMessage>{state.error}</FormMessage>
      {state.saved && <FormMessage kind="success">Saved.</FormMessage>}
      {canEdit ? (
        <SubmitButton pendingText="Saving…" className="sm:w-fit">
          Save changes
        </SubmitButton>
      ) : (
        <p className="text-muted-foreground text-sm">Only owners and admins can change these.</p>
      )}
    </form>
  );
}
