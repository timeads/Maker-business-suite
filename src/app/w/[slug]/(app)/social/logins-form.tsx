"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { startConnection, type ConnectionState } from "../connections/actions";
import { forgetSocialLogin, type AccountsState } from "./accounts-actions";

/** Connects a TikTok account or a LinkedIn person, or adds another; comes back here afterwards. */
export function ConnectLogin({
  slug,
  provider,
  label,
  network,
  variant = "outline",
}: {
  slug: string;
  provider: "tiktok" | "linkedin";
  label: string;
  network: string;
  variant?: "default" | "outline";
}) {
  const [state, action] = useActionState<ConnectionState, FormData>(
    startConnection.bind(null, slug, provider),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="return_to" value="social_accounts" />
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant={variant} pendingText={`Opening ${network}…`} className="w-fit">
        {label}
      </SubmitButton>
    </form>
  );
}

/** Disconnects one login; the others carry on. */
export function ForgetLogin({
  slug,
  provider,
  loginId,
  name,
}: {
  slug: string;
  provider: "tiktok" | "linkedin";
  loginId: string;
  name: string;
}) {
  const [state, action] = useActionState<AccountsState, FormData>(
    forgetSocialLogin.bind(null, slug, provider, loginId),
    {},
  );
  return (
    <form
      action={action}
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        if (
          !window.confirm(`Disconnect ${name}? Its posts stop going out; what's already up stays.`)
        ) {
          event.preventDefault();
        }
      }}
    >
      <SubmitButton variant="ghost" size="sm" pendingText="Disconnecting…" className="w-fit">
        Disconnect {name}
      </SubmitButton>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </form>
  );
}
