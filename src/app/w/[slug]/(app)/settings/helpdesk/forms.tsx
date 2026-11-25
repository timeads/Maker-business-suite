"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  deleteAutoTagRule,
  deleteFolder,
  deleteReplyTemplate,
  deleteView,
  saveFolder,
  saveView,
  saveAutoTagRule,
  saveReplyTemplate,
  type HelpdeskState,
} from "@/app/w/[slug]/helpdesk/actions";

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
          className="border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2"
        />
        <p className="text-muted-foreground text-xs">
          These fill themselves in when you use the reply: {"{{first_name}}"}, {"{{my_name}}"},{" "}
          {"{{order_number}}"}, {"{{order_date}}"}, {"{{order_total}}"}, {"{{order_status}}"} (from
          their latest order).
        </p>
      </div>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save reply
      </SubmitButton>
    </form>
  );
}

export function AddRuleForm({
  slug,
  people,
}: {
  slug: string;
  people: { id: string; name: string }[];
}) {
  const [state, action, saves] = useSettingsAction(saveAutoTagRule, slug);
  return (
    <form action={action} key={saves} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-contains">When a new email mentions</Label>
          <Input
            id="rule-contains"
            name="contains"
            maxLength={80}
            placeholder="tracking number"
            required
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-where">In</Label>
          <Select id="rule-where" name="where" defaultValue="anywhere">
            <option value="anywhere">Subject or message</option>
            <option value="subject">Subject</option>
            <option value="body">Message</option>
            <option value="from">Sender&apos;s address</option>
          </Select>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-tag">Tag it</Label>
          <Input id="rule-tag" name="tag" maxLength={30} placeholder="shipping" />
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-priority">Mark it</Label>
          <Select id="rule-priority" name="priority" defaultValue="">
            <option value="">Leave as it is</option>
            <option value="urgent">Urgent</option>
            <option value="high">High</option>
            <option value="low">Low</option>
          </Select>
        </div>
        <div className="flex flex-col gap-2">
          <Label htmlFor="rule-assign">Hand it to</Label>
          <Select id="rule-assign" name="assign_to" defaultValue="">
            <option value="">Nobody in particular</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <p className="text-muted-foreground text-xs">Fill in at least one of the three.</p>
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="outline" pendingText="Adding…" className="sm:w-fit">
        Add rule
      </SubmitButton>
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
  kind: "template" | "rule" | "folder" | "view";
  label: string;
}) {
  const [state, action] = useSettingsAction(
    {
      template: deleteReplyTemplate,
      rule: deleteAutoTagRule,
      folder: deleteFolder,
      view: deleteView,
    }[kind],
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

/** Make a folder, or (with `folder`) rename one. */
export function FolderForm({
  slug,
  folder,
}: {
  slug: string;
  folder?: { id: string; name: string };
}) {
  const [state, action, saves] = useSettingsAction(saveFolder, slug);
  const id = folder ? `folder-${folder.id}` : "folder-new";
  return (
    <form action={action} key={saves} className="flex flex-wrap items-end gap-2">
      {folder && <input type="hidden" name="id" value={folder.id} />}
      <div className="flex flex-col gap-1">
        <Label htmlFor={id} className={folder ? "sr-only" : undefined}>
          {folder ? `Rename ${folder.name}` : "New folder"}
        </Label>
        <Input
          id={id}
          name="name"
          maxLength={40}
          defaultValue={folder?.name}
          placeholder="Repairs"
          required
          className="w-56"
        />
      </div>
      <SubmitButton variant="outline" size="default" pendingText="Saving…">
        {folder ? "Rename" : "Add folder"}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

/** A saved view: a name and the conditions a conversation must meet. */
export function AddViewForm({
  slug,
  people,
  folders,
}: {
  slug: string;
  people: { id: string; name: string }[];
  folders: { id: string; name: string }[];
}) {
  const [state, action, saves] = useSettingsAction(saveView, slug);
  return (
    <form action={action} key={saves} className="grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-name">Name</Label>
        <Input id="view-name" name="name" maxLength={40} placeholder="VIP" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-status">Status</Label>
        <Select id="view-status" name="status" defaultValue="active">
          <option value="active">Open or in progress</option>
          <option value="open">Open</option>
          <option value="pending">In progress</option>
          <option value="snoozed">Snoozed</option>
          <option value="closed">Closed</option>
          <option value="any">Any status</option>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-tags">Has any of these tags</Label>
        <Input id="view-tags" name="tags" placeholder="vip, wholesale" autoComplete="off" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-assignee">Assigned to</Label>
        <Select id="view-assignee" name="assignee" defaultValue="">
          <option value="">Anyone</option>
          <option value="me">Whoever is looking</option>
          <option value="none">Nobody</option>
          {people.map((person) => (
            <option key={person.id} value={person.id}>
              {person.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-folder">Folder</Label>
        <Select id="view-folder" name="folder" defaultValue="">
          <option value="">Not filed (the inbox)</option>
          <option value="none">Not in any folder, any status</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-priority">Priority</Label>
        <Select id="view-priority" name="priority" defaultValue="">
          <option value="">Any</option>
          <option value="urgent">Urgent</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="view-text">Words in the subject or the customer</Label>
        <Input id="view-text" name="text" maxLength={80} placeholder="order status" />
      </div>
      <label className="flex items-center gap-2 self-end pb-2 text-sm">
        <input type="checkbox" name="unread" value="1" />
        Unread only
      </label>
      <div className="flex flex-col gap-2 sm:col-span-2">
        <FormMessage>{state.error}</FormMessage>
        <SubmitButton variant="outline" size="default" pendingText="Saving…" className="w-fit">
          Add view
        </SubmitButton>
      </div>
    </form>
  );
}
