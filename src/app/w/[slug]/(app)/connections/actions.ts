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
import { getProviderToken, vaultTokenStore } from "@/lib/connections/tokens";
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

/**
 * For providers that connect with a pasted API key: checks it with the
 * provider and saves it in one step. The key goes straight to Vault through
 * `save_connection`; it is never logged, echoed back or put in a URL.
 */
async function connectWithKey(
  slug: string,
  ctx: Extract<Awaited<ReturnType<typeof context>>, { adapter: unknown }>,
  input: Record<string, string>,
): Promise<ConnectionState> {
  try {
    const account = await ctx.adapter.connectWithKey!(input);
    const { error } = await getAdminClient().rpc("save_connection", {
      p_tenant_id: ctx.tenant.id,
      p_provider: ctx.provider,
      p_external_account_id: account.externalAccountId,
      p_display_name: account.displayName,
      p_scopes: account.scopes,
      p_token: account.token,
      p_connected_by: ctx.user.id,
      p_metadata: account.metadata ?? {},
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    if (err instanceof ConnectError) return { error: err.message };
    console.error(`${ctx.provider} connect failed`, err instanceof Error ? err.message : err);
    return { error: `Something went wrong connecting ${ctx.adapter.name}. Try again in a moment.` };
  }
  revalidatePath(`/w/${slug}/connections`);
  revalidatePath(`/w/${slug}/shipping`, "layout");
  revalidatePath(`/w/${slug}/stock`, "layout");
  return { message: `${ctx.adapter.name} is connected.` };
}

/**
 * Sends the person to the provider to approve the connection, or, for a
 * provider that takes an API key, checks and saves the key right here.
 */
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

  if (ctx.adapter.connectWithKey) return connectWithKey(slug, ctx, input);

  // Renewing a connection keeps what it was already granted (the help desk's
  // messages on a Facebook Page, say), read from the scopes on record.
  if (ctx.adapter.reconnectInput) {
    const { data: existing } = await (
      await createClient()
    )
      .from("connections")
      .select("scopes")
      .eq("tenant_id", ctx.tenant.id)
      .eq("provider", ctx.provider)
      .maybeSingle();
    const kept = ctx.adapter.reconnectInput((existing?.scopes as string[] | null) ?? []);
    for (const [name, value] of Object.entries(kept)) if (!input[name]) input[name] = value;
  }

  // A one-time proof for providers that want PKCE; it rides in the httpOnly
  // state cookie and goes to the provider only as its hash, then once more
  // with the code.
  if (ctx.adapter.pkce) input.pkce_verifier = randomBytes(48).toString("base64url");

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

/**
 * "Check again": asks the shop now which permissions it has really granted
 * and records that as the connection's scopes, so every gate (and the screen
 * the person pressed it on) tells the truth at once. Changes nothing in the
 * shop. Owners and admins only, like everything else about a connection.
 */
export async function checkShopPermissions(
  slug: string,
  _prev: ConnectionState,
): Promise<ConnectionState> {
  const ctx = await context(slug, "shopify");
  if ("error" in ctx) return { error: ctx.error };
  if (!ctx.adapter.grantedScopes) return { error: NOT_READY };

  // Read as the signed-in person, so RLS confirms the connection is theirs.
  const { data: connection } = await (
    await createClient()
  )
    .from("connections")
    .select("id, status")
    .eq("tenant_id", ctx.tenant.id)
    .eq("provider", "shopify")
    .maybeSingle();
  if (!connection || connection.status !== "active") {
    return { error: "Connect your shop first." };
  }

  try {
    const stored = await getProviderToken(ctx.tenant.id, "shopify");
    const granted = await ctx.adapter.grantedScopes(stored.token, stored.externalAccountId);
    const { error } = await getAdminClient().rpc("record_granted_scopes", {
      p_tenant_id: ctx.tenant.id,
      p_connection_id: connection.id,
      p_scopes: granted,
    });
    if (error) throw new Error(error.message);
  } catch (err) {
    console.error(
      "shopify permission check failed",
      err instanceof Error ? err.message : "unknown error",
    );
    return { error: "We couldn't reach your shop just now. Try again in a moment." };
  }
  revalidatePath(`/w/${slug}/settings`, "layout");
  revalidatePath(`/w/${slug}/connections`);
  revalidatePath(`/w/${slug}/shipping`, "layout");
  revalidatePath(`/w/${slug}/stock`, "layout");
  revalidatePath(`/w/${slug}/bookings`, "layout");
  return { message: "Checked with your shop just now." };
}
