import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Posts a heads-up from one of the workspace's tools into Messages (the
 * #alerts channel unless another is named). Never throws: a missed heads-up
 * must not undo the booking, post or reply that caused it.
 */
export async function postAlert(
  admin: SupabaseClient,
  tenantId: string,
  app: "bookings" | "helpdesk" | "social" | "money" | "stock" | "shipping",
  text: string,
  channel: string | null = null,
): Promise<void> {
  try {
    const { error } = await admin.rpc("post_app_chat_message", {
      p_tenant_id: tenantId,
      p_channel: channel,
      p_app: app,
      p_body: text,
    });
    if (error) console.error(`Could not post ${app} alert: ${error.message}`);
  } catch (err) {
    console.error(`Could not post ${app} alert`, err instanceof Error ? err.message : err);
  }
}
