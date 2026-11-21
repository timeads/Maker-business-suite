"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { firstError, workspaceSchema } from "@/lib/validation";

export type OnboardingState = { error?: string };

export async function createWorkspace(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  await requireUser("/onboarding");
  const parsed = workspaceSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
    currency: formData.get("currency"),
  });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("create_tenant", {
      p_name: parsed.data.name,
      p_timezone: parsed.data.timezone,
      p_currency: parsed.data.currency,
    })
    .single<{ slug: string }>();
  if (error || !data) {
    return { error: "We couldn't set up your workspace. Check the details and try again." };
  }
  redirect(`/w/${data.slug}`);
}
