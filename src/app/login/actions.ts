"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/safe-redirect";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { emailSchema, firstError } from "@/lib/validation";

export type LoginState = { error?: string; sentTo?: string };

async function callbackUrl(next: string) {
  const site = await getSiteUrl();
  return `${site}/auth/callback?next=${encodeURIComponent(next)}`;
}

export async function signInWithEmail(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = emailSchema.safeParse(formData.get("email"));
  if (!parsed.success) return { error: firstError(parsed.error) };
  const next = safeNextPath(formData.get("next"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data,
    options: { emailRedirectTo: await callbackUrl(next) },
  });
  if (error) {
    return {
      error: "We couldn't send your sign-in link just now. Give it another go in a minute.",
    };
  }
  return { sentTo: parsed.data };
}

export async function signInWithGoogle(formData: FormData) {
  const next = safeNextPath(formData.get("next"));
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: await callbackUrl(next) },
  });
  if (error || !data.url) {
    redirect(`/login?error=google&next=${encodeURIComponent(next)}`);
  }
  redirect(data.url);
}
