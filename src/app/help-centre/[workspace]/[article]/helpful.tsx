"use client";

import { useActionState } from "react";
import { answerHelpful, type HelpfulState } from "../actions";

const button =
  "border-border bg-card hover:border-ochre focus-visible:ring-ochre rounded-full border px-4 py-1.5 text-sm font-semibold outline-none focus-visible:ring-2 disabled:opacity-60";

/** "Was this helpful?" Yes or no, counted; nothing typed, nothing remembered in the browser. */
export function Helpful({ workspace, article }: { workspace: string; article: string }) {
  const [state, action, pending] = useActionState<HelpfulState, FormData>(
    answerHelpful.bind(null, workspace, article),
    {},
  );
  return (
    <section className="border-border flex flex-wrap items-center gap-3 border-t pt-6">
      <h2 className="text-sm font-semibold">Was this helpful?</h2>
      {state.said ? (
        <p role="status" className="text-text-2 font-read text-sm">
          {state.said}
        </p>
      ) : (
        <form action={action} className="flex gap-2">
          <button type="submit" name="helpful" value="yes" disabled={pending} className={button}>
            Yes
          </button>
          <button type="submit" name="helpful" value="no" disabled={pending} className={button}>
            No
          </button>
        </form>
      )}
    </section>
  );
}
