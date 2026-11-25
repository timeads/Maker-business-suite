"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { startConnection, type ConnectionState } from "@/app/w/[slug]/(app)/connections/actions";
import type { HelpdeskState } from "@/app/w/[slug]/helpdesk/actions";
import { saveChannelSwitches } from "@/app/w/[slug]/helpdesk/social-actions";

/**
 * Sends the person to Facebook to allow one more use of the connection
 * (messages, comments, posting). Only that use's permissions are asked for,
 * on top of what the connection already has; when they come back they land
 * on the screen that sent them.
 */
export function AllowMetaAccess({
  slug,
  label,
  access,
  returnTo,
  variant = "default",
}: {
  slug: string;
  label: string;
  /** A comma list of uses: "messages", "posting", "facebook_comments", "instagram_comments". */
  access: string;
  returnTo: "helpdesk_channels" | "social";
  variant?: "default" | "outline";
}) {
  const [state, action] = useActionState<ConnectionState, FormData>(
    startConnection.bind(null, slug, "meta"),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="access" value={access} />
      <input type="hidden" name="return_to" value={returnTo} />
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant={variant} pendingText="Opening Facebook…" className="w-fit">
        {label}
      </SubmitButton>
    </form>
  );
}

/** Which channels come into the help desk. */
export function ChannelSwitches({
  slug,
  instagram,
  facebook,
  humanAgent,
  canInstagram,
}: {
  slug: string;
  instagram: boolean;
  facebook: boolean;
  humanAgent: boolean;
  /** An Instagram professional account is linked to the connected Page. */
  canInstagram: boolean;
}) {
  const [state, action] = useActionState<HelpdeskState, FormData>(
    saveChannelSwitches.bind(null, slug),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="hidden" name="instagram_set" value="1" />
        <input
          type="checkbox"
          name="instagram"
          value="1"
          defaultChecked={instagram}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">Instagram messages</span>
          <span className="text-muted-foreground block text-xs">
            {canInstagram
              ? "Direct messages, story replies and shares sent to your Instagram account."
              : "No Instagram professional account is linked to the connected Page yet, so nothing will arrive until one is."}
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input type="hidden" name="facebook_set" value="1" />
        <input
          type="checkbox"
          name="facebook"
          value="1"
          defaultChecked={facebook}
          className="mt-0.5"
        />
        <span>
          <span className="font-semibold">Facebook messages</span>
          <span className="text-muted-foreground block text-xs">
            Messages people send your Facebook Page in Messenger.
          </span>
        </span>
      </label>
      <details className="text-sm">
        <summary className="text-muted-foreground w-fit cursor-pointer text-xs">
          For apps approved for Meta&apos;s Human Agent feature
        </summary>
        <label className="mt-2 flex items-start gap-2">
          <input type="hidden" name="human_agent_set" value="1" />
          <input
            type="checkbox"
            name="human_agent"
            value="1"
            defaultChecked={humanAgent}
            className="mt-0.5"
          />
          <span>
            Let a person reply for up to seven days
            <span className="text-muted-foreground block text-xs">
              Leave this off unless Meta has approved the app behind this suite for “Human Agent”.
              Without that approval Meta refuses replies after 24 hours whatever is ticked here.
            </span>
          </span>
        </label>
      </details>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton variant="outline" size="default" pendingText="Saving…" className="w-fit">
        Save
      </SubmitButton>
    </form>
  );
}
