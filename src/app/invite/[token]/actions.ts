"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export type AcceptState = { error?: string };

export async function acceptInvite(token: string, _prev: AcceptState): Promise<AcceptState> {
  await requireUser(`/invite/${token}`);
  const supabase = await createClient();
  const { data: slug, error } = await supabase.rpc("accept_invite", { p_token: token });
  if (error || typeof slug !== "string") {
    // accept_invite raises these codes with messages written for people.
    const friendly = error && ["P0002", "22023", "42501"].includes(error.code);
    return {
      error: friendly
        ? `${error.message}.`
        : "We couldn't accept that invite. Try again in a moment.",
    };
  }
  redirect(`/w/${slug}`);
}
