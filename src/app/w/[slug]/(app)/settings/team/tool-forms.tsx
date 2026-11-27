"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveMemberTools, setToolsPerPerson, type ToolsState } from "../actions";

export type ToolChoice = { key: string; name: string };

/** A row of ticks, one per tool the plan includes, and Money said plainly. */
export function ToolTicks({
  tools,
  ticked,
  idPrefix,
  onChange,
}: {
  tools: ToolChoice[];
  ticked: string[];
  idPrefix: string;
  onChange?: () => void;
}) {
  return (
    <fieldset className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <legend className="sr-only">Tools this person can open</legend>
      {tools.map((tool) => (
        <label
          key={tool.key}
          htmlFor={`${idPrefix}-${tool.key}`}
          className="flex items-center gap-2 text-sm"
        >
          <input
            id={`${idPrefix}-${tool.key}`}
            type="checkbox"
            name="tools"
            value={tool.key}
            defaultChecked={ticked.includes(tool.key)}
            onChange={onChange}
          />
          {tool.name}
        </label>
      ))}
      <span className="text-muted-foreground text-sm">Money: owners and admins only</span>
    </fieldset>
  );
}

/** One member's tools, saved with one press. */
export function MemberToolsForm({
  slug,
  userId,
  email,
  tools,
  ticked,
}: {
  slug: string;
  userId: string;
  email: string;
  tools: ToolChoice[];
  ticked: string[];
}) {
  const [state, action] = useActionState<ToolsState, FormData>(
    saveMemberTools.bind(null, slug),
    {},
  );
  const [changed, setChanged] = useState(false);
  return (
    <form
      action={(formData) => {
        setChanged(false);
        action(formData);
      }}
      className="flex flex-col gap-2"
      aria-label={`Tools for ${email}`}
    >
      <input type="hidden" name="userId" value={userId} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ToolTicks
          tools={tools}
          ticked={ticked}
          idPrefix={`tools-${userId}`}
          onChange={() => setChanged(true)}
        />
        <SubmitButton variant="outline" size="sm" pendingText="Saving…" disabled={!changed}>
          Save tools
        </SubmitButton>
      </div>
      <FormMessage>{state.error}</FormMessage>
      {state.saved && !changed && (
        <p role="status" className="text-muted-foreground text-xs">
          Saved. They see these tools the next time a page opens.
        </p>
      )}
    </form>
  );
}

/** The workspace's switch, with what it does in plain words. */
export function ToolsSwitchForm({ slug, on }: { slug: string; on: boolean }) {
  const [state, action] = useActionState<ToolsState, FormData>(
    setToolsPerPerson.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="on" value={on ? "no" : "yes"} />
      <div>
        <SubmitButton variant={on ? "outline" : "dark"} pendingText="Saving…">
          {on ? "Let every member open every tool again" : "Choose tools per person"}
        </SubmitButton>
      </div>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}
