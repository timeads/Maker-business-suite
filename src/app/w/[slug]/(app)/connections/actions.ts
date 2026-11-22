"use server";

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  OAUTH_COOKIE,
  OAUTH_COOKIE_MAX_AGE,
  OAUTH_COOKIE_PATH,
  encodeOAuthState,
} from "@/lib/connections/oauth-state";
import { getAdapter, isProviderKey } from "@/lib/connections/registry";
import { vaultTokenStore } from "@/lib/connections/tokens";
import { ConnectError, type ProviderKey } from "@/lib/connections/types";
import { getEntitlements } from "@/lib/entitlements";
import { getSiteUrl } from "@/lib/site-url";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";

export type ConnectionState = { error?: string; message?: string };

const NOT_ALLOWED = "Only owners and admins can manage connections.";
const READ_ONLY =
  "This workspace is read-only because its plan has ended. Pick a plan to make changes.";
const NOT_READY = "This connection isn't available in this environment yet.";

async function context(slug: string, provider: string) {
  const user = await requireUser(`/w/${slug}/connections`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx || !canManage(ctx.role)) return { error: NOT_ALLOWED } as const;
  if (!isProviderKey(provider)) return { error: NOT_READY } as const;
  const adapter = getAdapter(provider);
  if (!adapter.configured() || !process.env.SUPABASE_SECRET_KEY) {
    return { error: NOT_READY } as const;
  }
  return { user, tenant: ctx.tenant, provider: provider as ProviderKey, adapter } as const;
}

/** Sends the person to the provider to approve the connection. */
export async function startConnection(
  slug: string,
  provider: string,
  _prev: ConnectionState,
  formData: FormData,
): Promise<ConnectionState> {
  const ctx = await context(slug, provider);
  if ("error" in ctx) return { error: ctx.error };
  if (!(await getEntitlements(ctx.tenant.id)).canWrite) return { error: READ_ONLY };

  const input: Record<string, string> = {};
  for (const field of ctx.adapter.connectFields) {
    const value = formData.get(field.name);
    input[field.name] = typeof value === "string" ? value : "";
  }

  const state = randomBytes(24).toString("base64url");
  const site = await getSiteUrl();
  let url: string;
  try {
    url = ctx.adapter.beginConnect({
      state,
      redirectUri: `${site}/api/connections/${ctx.provider}/callback`,
      input,
    });
  } catch (err) {
    if (err instanceof ConnectError) return { error: err.message };
    throw err;
  }

  (await cookies()).set(
    OAUTH_COOKIE,
    encodeOAuthState({ state, slug, provider: ctx.provider, userId: ctx.user.id, input }),
    {
      httpOnly: true,
      secure: site.startsWith("https://"),
      sameSite: "lax",
      path: OAUTH_COOKIE_PATH,
      maxAge: OAUTH_COOKIE_MAX_AGE,
    },
  );
  redirect(url);
}

/** Removes access on the provider's side (best effort) and deletes our tokens. */
export async function disconnectConnection(
  slug: string,
  provider: string,
  _prev: ConnectionState,
): Promise<ConnectionState> {
  const ctx = await context(slug, provider);
  if ("error" in ctx) return { error: ctx.error };

  try {
    const admin = getAdminClient();
    const stored = await vaultTokenStore(admin).read(ctx.tenant.id, ctx.provider);
    if (!stored) return { message: `${ctx.adapter.name} is already disconnected.` };
    try {
      await ctx.adapter.disconnect(stored.token, stored.externalAccountId);
    } catch (err) {
      // The token may already be dead; our side is disconnected regardless.
      console.error(`${ctx.provider} revoke failed`, err instanceof Error ? err.message : err);
    }
    const { error } = await admin.rpc("mark_connection", {
      p_connection_id: stored.connectionId,
      p_status: "disconnected",
      p_error: null,
      p_actor: ctx.user.id,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(`${ctx.provider} disconnect failed`, err instanceof Error ? err.message : err);
    return { error: `We couldn't disconnect ${ctx.adapter.name}. Try again in a moment.` };
  }
  revalidatePath(`/w/${slug}/connections`);
  return { message: `${ctx.adapter.name} is disconnected.` };
}

/** Queues a sync now rather than waiting for the next scheduled one. */
export async function syncNow(
  slug: string,
  provider: string,
  _prev: ConnectionState,
): Promise<ConnectionState> {
  const ctx = await context(slug, provider);
  if ("error" in ctx) return { error: ctx.error };

  // Read the connection as the signed-in user, so RLS confirms it's theirs.
  const supabase = await createClient();
  const { data: connection } = await supabase
    .from("connections")
    .select("id, status")
    .eq("tenant_id", ctx.tenant.id)
    .eq("provider", ctx.provider)
    .maybeSingle();
  if (!connection || connection.status !== "active") {
    return { error: `Connect ${ctx.adapter.name} first.` };
  }

  const { data: queued, error } = await getAdminClient().rpc("enqueue_sync", {
    p_connection_id: connection.id,
    p_type: "incremental",
  });
  if (error) return { error: "We couldn't start a sync. Try again in a moment." };
  revalidatePath(`/w/${slug}/connections`);
  return {
    message: queued
      ? "Sync started. This page updates when it finishes."
      : "A sync is already underway.",
  };
}
