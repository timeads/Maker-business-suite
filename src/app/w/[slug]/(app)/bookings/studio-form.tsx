"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";

type State = { error?: string; message?: string };

/**
 * One small form for the supplies, vendors and budget pages: the fields are
 * drawn on the server and handed in as children; this only runs the action
 * and says how it went.
 */
export function StudioForm({
  action,
  children,
  submit,
  pending = "Saving…",
  variant,
  className = "flex flex-col gap-3",
}: {
  action: (prev: State, formData: FormData) => Promise<State>;
  children?: React.ReactNode;
  submit: string;
  pending?: string;
  variant?: "default" | "outline" | "ghost" | "dark" | "danger";
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className={className}>
      {children}
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton variant={variant} pendingText={pending} className="w-fit">
          {submit}
        </SubmitButton>
        <FormMessage>{state.error}</FormMessage>
        <FormMessage kind="success">{state.message}</FormMessage>
      </div>
    </form>
  );
}
