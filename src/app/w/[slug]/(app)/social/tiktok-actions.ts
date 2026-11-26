"use server";

import { requireUser } from "@/lib/auth";
import { getLoginToken } from "@/lib/connections/logins";
import { getAdapter } from "@/lib/connections/registry";
import { vaultTokenStore } from "@/lib/connections/tokens";
import { ReconnectRequiredError } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import {
  creatorChoicesRow,
  readCreatorChoices,
  tiktokAudited,
  type CreatorChoices,
} from "@/lib/social/tiktok-options";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getTenantContext } from "@/lib/tenants";
import { createTikTokClient } from "@/lib/tiktok/client";

export type TikTokChoicesResult =
  | { ok: true; choices: CreatorChoices; audited: boolean }
  | { ok: false; error: string; audited: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * What TikTok lets this account choose for a post right now (its "creator
 * info"), asked when the composer shows a TikTok account, as TikTok's own
 * rules for apps ask. Kept on the account, so the database checks a
 * scheduled post against it. Any member who can write posts may ask; the
 * token never leaves the server.
 */
export async function loadTikTokChoices(
  slug: string,
  accountId: string,
): Promise<TikTokChoicesResult> {
  const audited = tiktokAudited();
  const user = await requireUser(`/w/${slug}/social`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !UUID.test(accountId))
    return { ok: false, error: "That account isn't here.", audited };
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social")) {
    return { ok: false, error: "Social isn't part of this workspace's plan right now.", audited };
  }
  // Read as the member, so RLS confirms the account is this workspace's.
  const { data: account } = await (
    await createClient()
  )
    .from("social_accounts")
    .select("id, network, login_id, active")
    .eq("tenant_id", ctx.tenant.id)
    .eq("id", accountId)
    .maybeSingle();
  if (!account || account.network !== "tiktok" || !account.login_id) {
    return { ok: false, error: "That TikTok account isn't connected here.", audited };
  }
  try {
    const admin = getAdminClient();
    const { token } = await getLoginToken(ctx.tenant.id, "tiktok", account.login_id as string, {
      store: vaultTokenStore(admin),
      adapter: getAdapter,
      now: Date.now,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      async markLogin({ loginId, needs }) {
        await admin.rpc("mark_social_login", {
          p_tenant_id: ctx.tenant.id,
          p_provider: "tiktok",
          p_login_id: loginId,
          p_needs: needs,
        });
      },
    });
    const choices = readCreatorChoices(await createTikTokClient(token.access_token).creatorInfo());
    await admin.rpc("note_social_account_options", {
      p_tenant_id: ctx.tenant.id,
      p_account_id: accountId,
      p_options: creatorChoicesRow(choices),
    });
    return { ok: true, choices, audited };
  } catch (err) {
    if (err instanceof ReconnectRequiredError) {
      return {
        ok: false,
        error: "This TikTok account needs connecting again under Settings → Social accounts.",
        audited,
      };
    }
    console.error("tiktok creator info failed", err instanceof Error ? err.message : "unknown");
    return {
      ok: false,
      error: "TikTok didn't answer just now, so we can't show its choices. Try again in a moment.",
      audited,
    };
  }
}
