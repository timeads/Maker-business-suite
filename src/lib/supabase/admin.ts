import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}. See .env.example.`);
  return value;
}

/**
 * Service-role client: bypasses RLS. Server-only (webhooks, the worker,
 * billing actions). Tenant data must go through `withTenant`; use this
 * directly only for things that aren't tenant data, like the event queue.
 */
export function getAdminClient(): SupabaseClient {
  client ??= createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

function tenantScope(admin: SupabaseClient, tenantId: string) {
  return {
    tenantId,
    select: (table: string, columns: string) =>
      admin.from(table).select(columns).eq("tenant_id", tenantId),
    insert: (table: string, row: Record<string, unknown>) =>
      admin.from(table).insert({ ...row, tenant_id: tenantId }),
    upsert: (table: string, row: Record<string, unknown>, options?: { onConflict?: string }) =>
      admin.from(table).upsert({ ...row, tenant_id: tenantId }, options),
    update: (table: string, values: Record<string, unknown>) => {
      const safe = { ...values };
      delete safe.tenant_id;
      return admin.from(table).update(safe).eq("tenant_id", tenantId);
    },
  };
}

export type TenantScope = ReturnType<typeof tenantScope>;

/**
 * The only way service-role code touches tenant data (CLAUDE.md rule 2).
 * Every read and update is filtered to `tenantId`; every write is stamped
 * with it, overriding whatever the caller passed.
 */
export function withTenant<T>(
  tenantId: string,
  fn: (scope: TenantScope) => Promise<T>,
  admin: SupabaseClient = getAdminClient(),
): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) {
    return Promise.reject(new Error("withTenant needs a tenant id"));
  }
  return fn(tenantScope(admin, tenantId));
}
