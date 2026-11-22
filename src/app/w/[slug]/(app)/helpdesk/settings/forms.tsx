"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  deleteAutoTagRule,
  deleteReplyTemplate,
  saveAutoTagRule,
  saveReplyTemplate,
  type HelpdeskState,
} from "../actions";

type Action = (slug: string, prev: HelpdeskState, formData: FormData) => Promise<HelpdeskState>;

/** Runs a settings action and counts successful saves, so a form can clear itself afterwards. */
function useSettingsAction(action: Action, slug: string) {
  const [saves, setSaves] = useState(0);
  const [state, run] = useActionState<HelpdeskState, FormData>(async (prev, formData) => {
    const result = await action(slug, prev, formData);
    if (result.message) setSaves((count) => count + 1);
    return result;
  }, {});
  return [state, run, saves] as const;
}

export function AddTemplateForm({ slug }: { slug: string }) {
  const [state, action, saves] = useSettingsAction(saveReplyTemplate, slug);
  return (
    // Remounting after a save clears the fields.
    <form action={action} key={saves} className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        <Label htmlFor="template-name">Name</Label>
        <Input
          id="template-name"
          name="name"
          maxLength={60}
          placeholder="Custom order lead time"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="template-body">Reply</Label>
        <textarea
          id="template-body"
          name="body"
          rows={5}
          maxLength={4000}
          required
          placeholder={"Hi {{first_name}},\n\nCustom pieces take about three weeks…"}
          className="border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2"
        />
        <p className="text-muted-foreground text-xs">
          Write {"{{first_name}}"} where the customer&apos;s first name should go.
        </p>
      </div>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save reply
      </SubmitButton>
    </form>
  );
}

export function AddRuleForm({ slug }: { slug: string }) {
  const [state, action, saves] = useSettingsAction(saveAutoTagRule, slug);
  return (
    <form
      action={action}
      key={saves}
      className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end"
    >
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="rule-contains">When an email mentions</Label>
        <Input
          id="rule-contains"
          name="contains"
          maxLength={80}
          placeholder="tracking number"
          required
        />
      </div>
      <div className="flex flex-col gap-2 sm:w-40">
        <Label htmlFor="rule-where">In</Label>
        <Select id="rule-where" name="where" defaultValue="anywhere">
          <option value="anywhere">Subject or message</option>
          <option value="subject">Subject</option>
          <option value="body">Message</option>
        </Select>
      </div>
      <div className="flex flex-col gap-2 sm:w-40">
        <Label htmlFor="rule-tag">Tag it</Label>
        <Input id="rule-tag" name="tag" maxLength={30} placeholder="shipping" required />
      </div>
      <SubmitButton pendingText="Adding…">Add rule</SubmitButton>
      <div className="basis-full">
        <FormMessage>{state.error}</FormMessage>
      </div>
    </form>
  );
}

export function DeleteButton({
  slug,
  id,
  kind,
  label,
}: {
  slug: string;
  id: string;
  kind: "template" | "rule";
  label: string;
}) {
  const [state, action] = useSettingsAction(
    kind === "template" ? deleteReplyTemplate : deleteAutoTagRule,
    slug,
  );
  return (
    <form action={action} className="flex items-center gap-2">
      <input type="hidden" name="id" value={id} />
      <SubmitButton variant="ghost" size="sm" pendingText="Removing…" aria-label={label}>
        Remove
      </SubmitButton>
      {state.error && <span className="text-destructive text-xs">{state.error}</span>}
    </form>
  );
}
