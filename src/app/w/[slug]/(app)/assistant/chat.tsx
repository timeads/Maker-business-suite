"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  applyActionProposal,
  applyProposal,
  askAssistant,
  dismissActionProposal,
  dismissProposal,
  restoreVersion,
} from "./actions";
import type { ProposalPreview } from "./preview";

type Turn = {
  id: number;
  role: "user" | "assistant";
  text: string;
  proposals?: ProposalPreview[];
};

const SUGGESTIONS = [
  "What were my best sellers last month?",
  "Put top products at the top of my Money page",
  "Add a saved reply for custom order lead times",
  "Ask for a phone number on my booking form",
];

function Lines({ title, lines }: { title: string; lines: string[] }) {
  return (
    <div className="flex flex-col gap-1">
      <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{title}</p>
      <ul className="flex flex-col gap-0.5 text-sm">
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

export function ProposalCard({
  slug,
  proposal,
  canApply,
}: {
  slug: string;
  proposal: ProposalPreview;
  canApply: boolean;
}) {
  const action = proposal.source === "action";
  const [applied, apply] = useActionState(
    (action ? applyActionProposal : applyProposal).bind(null, slug, proposal.id),
    {},
  );
  const [dismissed, dismiss] = useActionState(
    (action ? dismissActionProposal : dismissProposal).bind(null, slug, proposal.id),
    {},
  );
  const done = applied.done ?? dismissed.done;
  return (
    <div className="border-border bg-card flex flex-col gap-3 rounded-md border p-4">
      <div>
        <p className="text-sm font-semibold">Suggested change: {proposal.name}</p>
        <p className="text-muted-foreground text-sm">{proposal.summary}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Lines title="Now" lines={proposal.before} />
        <Lines title="After" lines={proposal.after} />
      </div>
      <FormMessage>{applied.error ?? dismissed.error}</FormMessage>
      {done ? (
        <FormMessage kind="success">
          {done === "applied"
            ? action
              ? "Applied."
              : "Applied. You can put it back from Recent changes."
            : "Dismissed."}
        </FormMessage>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {canApply ? (
            <form action={apply}>
              <SubmitButton pendingText="Applying…">Apply this change</SubmitButton>
            </form>
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can apply this from the Assistant page.
            </p>
          )}
          <form action={dismiss}>
            <SubmitButton variant="outline">No thanks</SubmitButton>
          </form>
        </div>
      )}
    </div>
  );
}

export function RestoreButton({ slug, versionId }: { slug: string; versionId: string }) {
  const [state, action] = useActionState(restoreVersion.bind(null, slug, versionId), {});
  if (state.done) return <span className="text-muted-foreground text-sm">Put back</span>;
  return (
    <form action={action} className="flex items-center gap-2">
      {state.error && <span className="text-destructive text-xs">{state.error}</span>}
      <SubmitButton variant="outline" pendingText="Putting back…" className="h-8 px-3 text-xs">
        Put this back
      </SubmitButton>
    </form>
  );
}

export function Chat({
  slug,
  canApply,
  ready,
  initialUsage,
}: {
  slug: string;
  canApply: boolean;
  /** False when the assistant isn't configured in this environment. */
  ready: boolean;
  initialUsage: "ok" | "warning" | "exhausted";
}) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [usage, setUsage] = useState(initialUsage);
  const [pending, startTransition] = useTransition();
  const nextId = useRef(1);
  const blocked = !ready || usage === "exhausted";

  function send(text: string) {
    const message = text.trim();
    if (!message || pending || blocked) return;
    const history = turns.map(({ role, text: t }) => ({ role, text: t }));
    setTurns((all) => [...all, { id: nextId.current++, role: "user", text: message }]);
    setDraft("");
    setError(undefined);
    startTransition(async () => {
      const result = await askAssistant(slug, history, message);
      if (result.usage) setUsage(result.usage);
      if (result.error) {
        setError(result.error);
        return;
      }
      setTurns((all) => [
        ...all,
        {
          id: nextId.current++,
          role: "assistant",
          text: result.reply ?? "",
          proposals: result.proposals,
        },
      ]);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {usage === "warning" && (
        <FormMessage kind="success">
          Heads up: you&apos;ve used more than 80% of this month&apos;s AI allowance.
        </FormMessage>
      )}
      {usage === "exhausted" && (
        <FormMessage>
          You&apos;ve used this month&apos;s AI allowance. It resets next month, or you can upgrade
          your plan for more.
        </FormMessage>
      )}

      {turns.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">Try asking:</p>
          <div className="flex flex-wrap gap-2">
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion}
                type="button"
                variant="outline"
                className="h-auto px-3 py-2 text-left text-sm whitespace-normal"
                disabled={blocked || pending}
                onClick={() => send(suggestion)}
              >
                {suggestion}
              </Button>
            ))}
          </div>
        </div>
      ) : (
        <ol className="flex flex-col gap-4" aria-live="polite">
          {turns.map((turn) => (
            <li key={turn.id} className="flex flex-col gap-3">
              <div
                className={
                  turn.role === "user"
                    ? "bg-muted ml-auto max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-line"
                    : "max-w-[85%] text-sm whitespace-pre-line"
                }
              >
                <span className="sr-only">{turn.role === "user" ? "You: " : "Assistant: "}</span>
                {turn.text}
              </div>
              {turn.proposals?.map((proposal) => (
                <ProposalCard
                  key={proposal.id}
                  slug={slug}
                  proposal={proposal}
                  canApply={canApply}
                />
              ))}
            </li>
          ))}
          {pending && <li className="text-muted-foreground text-sm">Thinking…</li>}
        </ol>
      )}

      <FormMessage>{error}</FormMessage>
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <label htmlFor="assistant-message" className="sr-only">
          Message
        </label>
        <textarea
          id="assistant-message"
          rows={2}
          maxLength={4000}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
          placeholder={
            ready
              ? "Ask about your sales, or ask for a change…"
              : "The assistant isn't switched on yet"
          }
          disabled={blocked}
          className="border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 disabled:opacity-60 sm:flex-1"
        />
        <Button type="submit" disabled={blocked || pending || !draft.trim()}>
          {pending ? "Sending…" : "Send"}
        </Button>
      </form>
      <p className="text-muted-foreground text-xs">
        The assistant can look things up and suggest changes. It never changes anything until
        someone applies its suggestion, and it can&apos;t send emails or posts.
      </p>
    </div>
  );
}
