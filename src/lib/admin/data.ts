import { createClient } from "@/lib/supabase/server";
import {
  healthSchema,
  workspaceDetailSchema,
  workspaceRowSchema,
  type Health,
  type WorkspaceDetail,
  type WorkspaceRow,
} from "./facts";

/**
 * Reads for the admin pages. Each one is a database function called with the
 * signed-in admin's own session (never the service role): the function
 * checks the caller is a platform admin and refuses anyone else.
 */

export async function loadWorkspaces(): Promise<WorkspaceRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_list_workspaces");
  if (error) throw new Error(`Could not load workspaces: ${error.message}`);
  return workspaceRowSchema.array().parse(data ?? []);
}

export async function loadHealth(): Promise<Health> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_health");
  if (error) throw new Error(`Could not load the health totals: ${error.message}`);
  return healthSchema.parse(Array.isArray(data) ? data[0] : data);
}

/** Null when there is no such workspace. */
export async function loadWorkspace(tenantId: string): Promise<WorkspaceDetail | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
    return null;
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("admin_workspace", { p_tenant_id: tenantId });
  if (error) throw new Error(`Could not load the workspace: ${error.message}`);
  return data ? workspaceDetailSchema.parse(data) : null;
}
