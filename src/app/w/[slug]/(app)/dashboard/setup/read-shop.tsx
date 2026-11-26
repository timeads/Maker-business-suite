"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import { syncNow, type ConnectionState } from "../../connections/actions";

/** "Read the shop now": queues a shop sync through the usual path (owners and admins). */
export function ReadShopButton({ slug }: { slug: string }) {
  const [state, action] = useActionState<ConnectionState, FormData>(
    syncNow.bind(null, slug, "shopify"),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-1">
      <SubmitButton variant="outline" size="sm" pendingText="Starting…" className="w-fit">
        Read the shop now
      </SubmitButton>
      {state.error && (
        <span role="alert" className="text-brick text-xs">
          {state.error}
        </span>
      )}
      {state.message && (
        <span role="status" className="text-muted-foreground text-xs">
          Give it a few minutes, then refresh this page.
        </span>
      )}
    </form>
  );
}
