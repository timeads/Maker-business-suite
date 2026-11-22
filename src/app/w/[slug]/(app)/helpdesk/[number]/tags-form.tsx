"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { setTicketTags, type HelpdeskState } from "../actions";

export function TagsForm({
  slug,
  ticketId,
  tags,
  canEdit,
}: {
  slug: string;
  ticketId: string;
  tags: string[];
  canEdit: boolean;
}) {
  const [state, action] = useActionState<HelpdeskState, FormData>(
    setTicketTags.bind(null, slug, ticketId),
    {},
  );
  if (!canEdit) {
    return <p className="text-muted-foreground text-sm">{tags.join(", ") || "No tags."}</p>;
  }
  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor="tags" className="sr-only">
        Tags
      </Label>
      <Input
        id="tags"
        name="tags"
        key={tags.join(",")}
        defaultValue={tags.join(", ")}
        placeholder="shipping, wholesale"
        autoComplete="off"
      />
      <p className="text-muted-foreground text-xs">Separate tags with commas.</p>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
        Save tags
      </SubmitButton>
    </form>
  );
}
