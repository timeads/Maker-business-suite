"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type JoinState = { error?: string };

/** Accepts an invite that was sent to the signed-in person's own email. */
export async function joinWorkspace(inviteId: string, _prev: JoinState): Promise<JoinState> {
  await requireUser("/app");
  const supabase = await createClient();
  const { data: slug, error } = await supabase.rpc("accept_invite_by_id", {
    p_invite_id: inviteId,
  });
  if (error || typeof slug !== "string") {
    // accept_invite_by_id raises these codes with messages written for people.
    const friendly = error && ["P0002", "22023", "42501"].includes(error.code);
    return {
      error: friendly
        ? `${error.message}.`
        : "We couldn't accept that invite. Try again in a moment.",
    };
  }
  redirect(`/w/${slug}`);
}
