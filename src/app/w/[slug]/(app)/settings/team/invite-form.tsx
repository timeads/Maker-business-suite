"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { inviteTeammate, type InviteState } from "../actions";
import { ToolTicks, type ToolChoice } from "./tool-forms";

/**
 * `tools` is set once the workspace chooses tools per person: a member's
 * invite then carries the ticked tools, and none ticked means none.
 */
export function InviteForm({ slug, tools }: { slug: string; tools?: ToolChoice[] }) {
  const [role, setRole] = useState("member");
  const [state, action] = useActionState<InviteState, FormData>(
    inviteTeammate.bind(null, slug),
    {},
  );
  const [copied, setCopied] = useState(false);

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <form
        action={(formData) => {
          setCopied(false);
          action(formData);
        }}
        className="flex flex-col gap-3"
      >
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-2">
            <Label htmlFor="invite-email">Email</Label>
            <Input
              id="invite-email"
              name="email"
              type="email"
              placeholder="teammate@yourstudio.com"
              required
            />
          </div>
          <div className="flex flex-col gap-2 sm:w-36">
            <Label htmlFor="invite-role">Role</Label>
            <Select
              id="invite-role"
              name="role"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </Select>
          </div>
          <SubmitButton pendingText="Inviting…">Send invite</SubmitButton>
        </div>
        {tools &&
          (role === "member" ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Tools they can open</p>
              <ToolTicks tools={tools} ticked={[]} idPrefix="invite-tools" />
              <p className="text-muted-foreground text-xs">
                Tick none and they start with Home and Messages only. You can change this on this
                page any time.
              </p>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">Admins open every tool, Money included.</p>
          ))}
      </form>

      <FormMessage>{state.error}</FormMessage>

      {state.invited && (
        <div
          role="status"
          className="border-border bg-muted flex flex-col gap-2 rounded-md border p-3"
        >
          <p className="text-sm">
            {state.invited.emailed
              ? `Invite sent to ${state.invited.email}. You can also share this link yourself:`
              : `Invite ready for ${state.invited.email}. Send them this link — it's shown only once:`}
          </p>
          <div className="flex gap-2">
            <Input
              readOnly
              value={state.invited.link}
              aria-label="Invite link"
              onFocus={(e) => e.currentTarget.select()}
              className="font-mono text-xs"
            />
            <Button type="button" variant="outline" onClick={() => copy(state.invited!.link)}>
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Works for 7 days, and only for someone signed in as {state.invited.email}.
          </p>
        </div>
      )}
    </div>
  );
}
