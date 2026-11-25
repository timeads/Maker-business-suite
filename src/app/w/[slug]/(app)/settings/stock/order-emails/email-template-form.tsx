"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveOrderEmailTemplate } from "../../../stock/orders/[number]/email-actions";

/** The words every order email starts from. Each one can still be changed before it is sent. */
export function OrderEmailTemplateForm({
  slug,
  template,
  workspaceName,
}: {
  slug: string;
  template: { subject: string; body: string; cc_me: boolean; from_name: string };
  workspaceName: string;
}) {
  const [state, action] = useActionState(saveOrderEmailTemplate.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-email-subject">Subject</Label>
          <Input
            id="po-email-subject"
            name="subject"
            defaultValue={template.subject}
            maxLength={200}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-email-from">Name suppliers see it from</Label>
          <Input
            id="po-email-from"
            name="from_name"
            defaultValue={template.from_name}
            maxLength={80}
            placeholder={workspaceName}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="po-email-body">Message</Label>
        <textarea
          id="po-email-body"
          name="body"
          defaultValue={template.body}
          rows={8}
          maxLength={4000}
          required
          className="border-input bg-card font-read rounded-md border px-3 py-2 text-sm"
        />
        <p className="text-muted-foreground text-xs">
          These are swapped for the order&apos;s own words: {"{{po_reference}}"},{" "}
          {"{{supplier_name}}"}, {"{{contact_name}}"}, {"{{month}}"} and {"{{sender_name}}"} (the
          first name of whoever presses send).
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="cc_me" defaultChecked={template.cc_me} />
        Start with “send a copy to my own address” ticked
      </label>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save the email
      </SubmitButton>
    </form>
  );
}
