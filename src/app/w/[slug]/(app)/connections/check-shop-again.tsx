"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { checkShopPermissions } from "./actions";

/** "Check again": asks the shop now what it has granted. Changes nothing in the shop. */
export function CheckShopAgain({ slug }: { slug: string }) {
  const [state, action] = useActionState(checkShopPermissions.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <SubmitButton variant="outline" pendingText="Asking your shop…" className="w-fit">
        Check again
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
