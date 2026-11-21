"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { sendInviteEmail } from "@/lib/email";
import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { firstError, inviteSchema, workspaceSchema } from "@/lib/validation";

async function requireManager(slug: string) {
  const user = await requireUser(`/w/${slug}/settings`);
  const ctx = await getTenantContext(slug, user.id);
  // The database enforces this too; checking here just gives a kinder message.
  if (!ctx || !canManage(ctx.role)) return null;
  return { user, ...ctx };
}

export type SettingsState = { error?: string; saved?: boolean };

export async function updateWorkspace(
  slug: string,
  _prev: SettingsState,
  formData: FormData,
): Promise<SettingsState> {
  const ctx = await requireManager(slug);
  if (!ctx) return { error: "Only owners and admins can change workspace settings." };

  const parsed = workspaceSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
    currency: formData.get("currency"),
  });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .update(parsed.data)
    .eq("id", ctx.tenant.id)
    .select("id");
  if (error || !data?.length) {
    return { error: "We couldn't save that. Check the details and try again." };
  }
  revalidatePath(`/w/${slug}`, "layout");
  return { saved: true };
}

export type InviteState = {
  error?: string;
  invited?: { email: string; link: string; emailed: boolean };
};

export async function inviteTeammate(
  slug: string,
  _prev: InviteState,
  formData: FormData,
): Promise<InviteState> {
  const ctx = await requireManager(slug);
  if (!ctx) return { error: "Only owners and admins can invite people." };

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) return { error: firstError(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("create_invite", {
      p_tenant_id: ctx.tenant.id,
      p_email: parsed.data.email,
      p_role: parsed.data.role,
    })
    .single<{ token: string }>();
  if (error || !data) {
    if (error?.code === "23505") return { error: "That person is already on the team." };
    return { error: "We couldn't create that invite. Try again in a moment." };
  }

  const link = `${await getSiteUrl()}/invite/${data.token}`;
  const emailed = await sendInviteEmail({
    to: parsed.data.email,
    workspaceName: ctx.tenant.name,
    inviterEmail: ctx.user.email,
    link,
  });
  revalidatePath(`/w/${slug}/settings/team`);
  return { invited: { email: parsed.data.email, link, emailed } };
}

export async function revokeInvite(slug: string, formData: FormData): Promise<void> {
  const ctx = await requireManager(slug);
  const inviteId = formData.get("inviteId");
  if (!ctx || typeof inviteId !== "string") return;
  const supabase = await createClient();
  await supabase.rpc("revoke_invite", { p_invite_id: inviteId });
  revalidatePath(`/w/${slug}/settings/team`);
}
