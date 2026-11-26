"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { changeLogins, loginToken, withoutLogin } from "@/lib/connections/logins";
import { getAdapter } from "@/lib/connections/registry";
import { vaultTokenStore } from "@/lib/connections/tokens";
import { getEntitlements } from "@/lib/entitlements";
import { loadChannelFacts } from "@/lib/helpdesk/social/server";
import { syncPageSubscriptions } from "@/lib/helpdesk/social/subscriptions";
import { checkAccountChoices } from "@/lib/social/accounts";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type AccountsState = { error?: string; message?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REFUSALS: Record<string, string> = {
  in_use:
    "Another workspace already uses one of those accounts. It can only be used in one place at a time.",
  not_offered:
    "Facebook no longer shares one of those accounts with us. Connect again and tick its Page.",
  too_many_accounts: "That's more accounts of one kind than a workspace can use.",
  "Brand not found": "Pick one of your brands for each account (not one that's put away).",
};

/**
 * Which of the Pages and Instagram accounts Facebook shared are used, and as
 * which brand. Owners and admins only; the database checks again. The plan's
 * limit per network is checked here (lib/entitlements.ts). Afterwards each
 * Page is asked to send (or stop sending) its messages and comments.
 */
export async function saveSocialAccounts(
  slug: string,
  _prev: AccountsState,
  formData: FormData,
): Promise<AccountsState> {
  const user = await requireUser(`/w/${slug}/settings/social/accounts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: "We couldn't find that workspace." };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can choose accounts." };
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.canWrite) {
    return { error: "This workspace is read-only because its plan has ended." };
  }
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("social_accounts")
    .select("id, network, active, brand_id")
    .eq("tenant_id", ctx.tenant.id);
  const accounts = (rows ?? []) as {
    id: string;
    network: string;
    active: boolean;
    brand_id: string;
  }[];
  const choices = accounts
    .filter((account) => formData.has(`seen:${account.id}`))
    .map((account) => {
      const brand = String(formData.get(`brand:${account.id}`) ?? "");
      return {
        id: account.id,
        active: formData.get(`active:${account.id}`) === "1",
        brand_id: UUID.test(brand) ? brand : account.brand_id,
      };
    });
  const problem = checkAccountChoices(accounts, choices, entitlements.limit("social_accounts"));
  if (problem) return { error: problem };
  const { error } = await supabase.rpc("choose_social_accounts", {
    p_tenant_id: ctx.tenant.id,
    p_choices: choices,
  });
  if (error)
    return { error: REFUSALS[error.message] ?? "We couldn't save that. Please try again." };
  revalidatePath(`/w/${slug}`, "layout");

  let note = "";
  if (process.env.META_APP_SECRET && process.env.SUPABASE_SECRET_KEY) {
    try {
      const admin = getAdminClient();
      const facts = await loadChannelFacts(admin, ctx.tenant.id);
      if (facts.connection?.status === "active") {
        await syncPageSubscriptions(
          admin,
          ctx.tenant.id,
          facts.settings,
          facts.connection.scopes ?? [],
        );
      }
    } catch {
      note =
        " Meta didn't confirm which Pages send us their messages just now; press Save again in a minute.";
    }
  }
  return { message: `Saved.${note}` };
}

/**
 * Lets go of one TikTok or LinkedIn login (owners and admins): its accounts
 * stop posting (the database checks the role and puts them out of use),
 * then its tokens are revoked where the network allows and forgotten, under
 * the connection's lock so the other logins are kept as they are. The last
 * login going disconnects the connection.
 */
export async function forgetSocialLogin(
  slug: string,
  provider: string,
  loginId: string,
  _prev: AccountsState,
  _formData: FormData,
): Promise<AccountsState> {
  const user = await requireUser(`/w/${slug}/settings/social/accounts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) return { error: "We couldn't find that workspace." };
  if (!canManage(ctx.role)) return { error: "Only owners and admins can disconnect an account." };
  if ((provider !== "tiktok" && provider !== "linkedin") || !loginId || loginId.length > 200) {
    return { error: "That login isn't here." };
  }
  const { data: left, error } = await (
    await createClient()
  ).rpc("forget_social_login", {
    p_tenant_id: ctx.tenant.id,
    p_provider: provider,
    p_login_id: loginId,
  });
  if (error) return { error: "We couldn't disconnect that just now. Please try again." };
  try {
    const admin = getAdminClient();
    const store = vaultTokenStore(admin);
    const adapter = getAdapter(provider);
    const stored = await store.read(ctx.tenant.id, provider);
    const login = stored ? loginToken(stored.token, loginId) : null;
    if (login) await adapter.disconnectLogin?.(login, loginId).catch(() => undefined);
    if (stored && Number(left) === 0) {
      await admin.rpc("mark_connection", {
        p_connection_id: stored.connectionId,
        p_status: "disconnected",
        p_error: null,
        p_actor: user.id,
      });
    } else if (stored) {
      await changeLogins(ctx.tenant.id, provider, (token) => withoutLogin(token, loginId), {
        store,
        wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      });
    }
  } catch (err) {
    console.error(
      `${provider} login forget failed`,
      err instanceof Error ? err.message : "unknown",
    );
    return {
      message:
        "It's disconnected here and won't post again. We couldn't tidy away its access just now; that does no harm.",
    };
  }
  revalidatePath(`/w/${slug}`, "layout");
  return { message: "Disconnected. It won't post again." };
}
