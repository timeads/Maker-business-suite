"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { applyTemplate, type TemplateState } from "./actions";

type Option = { key: string; name: string; blurb: string };

export function TemplatePicker({
  slug,
  options,
  currentName,
}: {
  slug: string;
  options: Option[];
  currentName: string;
}) {
  const [state, action] = useActionState<TemplateState, FormData>(
    applyTemplate.bind(null, slug),
    {},
  );
  return (
    <details className="group relative">
      <summary className="border-input bg-card hover:bg-muted flex h-8 cursor-pointer list-none items-center rounded-md border px-3 text-xs font-medium [&::-webkit-details-marker]:hidden">
        Layout: {currentName}
      </summary>
      <div className="border-border bg-card absolute right-0 z-20 mt-1 flex w-72 flex-col gap-3 rounded-md border p-3 shadow-lg">
        <p className="text-muted-foreground text-xs">
          Start from a ready-made layout. This replaces the current one.
        </p>
        {options.map((option) => (
          <form key={option.key} action={action} className="flex flex-col gap-1.5">
            <input type="hidden" name="template" value={option.key} />
            <p className="text-sm font-medium">{option.name}</p>
            <p className="text-muted-foreground text-xs">{option.blurb}</p>
            <SubmitButton variant="outline" size="sm" pendingText="Applying…" className="w-fit">
              Use this layout
            </SubmitButton>
          </form>
        ))}
        <FormMessage>{state.error}</FormMessage>
      </div>
    </details>
  );
}
