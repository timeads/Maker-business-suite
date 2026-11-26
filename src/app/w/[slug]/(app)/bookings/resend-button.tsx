"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import type { BookingsState } from "./actions";
import { resendConfirmation } from "./roster-actions";

/** "Send the confirmation again" from a list: one press, the answer in words beside it. */
export function ResendButton({ slug, bookingId }: { slug: string; bookingId: string }) {
  const [state, setState] = useState<BookingsState>({});
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => start(async () => setState(await resendConfirmation(slug, bookingId)))}
      >
        {pending ? "Sending…" : "Send the confirmation again"}
      </Button>
      {(state.error || state.message) && (
        <p
          role={state.error ? "alert" : "status"}
          className={state.error ? "text-brick text-xs" : "text-mint-ink text-xs"}
        >
          {state.error ?? state.message}
        </p>
      )}
    </div>
  );
}
