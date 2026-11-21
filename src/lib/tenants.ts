import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

export type Role = "owner" | "admin" | "member";

export type Tenant = {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  currency: string;
};

const TENANT_COLUMNS = "id, name, slug, timezone, currency";

/** Workspaces the signed-in user belongs to. RLS does the filtering. */
export const listMyTenants = cache(async (): Promise<Tenant[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tenants")
    .select(TENANT_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load workspaces: ${error.message}`);
  return data ?? [];
});

/** The workspace at `slug` plus the user's role in it, or null if they aren't a member. */
export const getTenantContext = cache(
  async (slug: string, userId: string): Promise<{ tenant: Tenant; role: Role } | null> => {
    const supabase = await createClient();
    const { data: tenant, error } = await supabase
      .from("tenants")
      .select(TENANT_COLUMNS)
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw new Error(`Could not load workspace: ${error.message}`);
    if (!tenant) return null;

    const { data: membership } = await supabase
      .from("memberships")
      .select("role")
      .eq("tenant_id", tenant.id)
      .eq("user_id", userId)
      .maybeSingle();
    if (!membership) return null;

    return { tenant, role: membership.role as Role };
  },
);

export function canManage(role: Role): boolean {
  return role === "owner" || role === "admin";
}
