import type { SupabaseClient } from "@supabase/supabase-js";
import type { Priority } from "../config";
import type { SavedView } from "../saved-views";
import type { Shelf } from "../views";
import type { ManualSources } from "./config";
import { isSourceConversation, type SourceTicket } from "./sources";

type Row = {
  id: string;
  subject: string;
  status: SourceTicket["status"];
  shelf: Shelf | null;
  merged_into: string | null;
  folder_id: string | null;
  assignee_id: string | null;
  priority: Priority;
  first_reply_at: string | null;
  contacts:
    { email: string; name: string | null } | { email: string; name: string | null }[] | null;
  ticket_tags: { tags: { name: string } | { name: string }[] | null }[] | null;
};

const one = <T>(value: T | T[] | null | undefined): T | null =>
  Array.isArray(value) ? (value[0] ?? null) : (value ?? null);

/**
 * How many source conversations are waiting to be read, counted as the
 * member from the newest few hundred closed conversations. The same rule
 * the worker uses (`isSourceConversation`), so the number on the page is the
 * number an update would find.
 */
export async function countWaiting(
  supabase: SupabaseClient,
  tenantId: string,
  sources: ManualSources,
  savedViews: SavedView[],
): Promise<number> {
  const [{ data }, { data: reads }] = await Promise.all([
    supabase
      .from("tickets")
      .select(
        "id, subject, status, shelf, merged_into, folder_id, assignee_id, priority, first_reply_at, contacts(email, name), ticket_tags(tags(name))",
      )
      .eq("tenant_id", tenantId)
      .eq("status", "closed")
      .order("last_message_at", { ascending: false })
      .limit(400),
    supabase.from("manual_reads").select("ticket_id").eq("tenant_id", tenantId).limit(5000),
  ]);
  const done = new Set(((reads ?? []) as { ticket_id: string }[]).map((r) => r.ticket_id));
  return ((data ?? []) as unknown as Row[]).filter((row) => {
    if (done.has(row.id)) return false;
    const contact = one(row.contacts);
    return isSourceConversation(
      {
        id: row.id,
        status: row.status,
        shelf: row.shelf,
        merged_into: row.merged_into,
        folder_id: row.folder_id,
        assignee_id: row.assignee_id,
        priority: row.priority,
        tags: (row.ticket_tags ?? []).flatMap((t) => {
          const tag = one(t.tags);
          return tag ? [tag.name] : [];
        }),
        subject: row.subject,
        customer: `${contact?.name ?? ""} ${contact?.email ?? ""}`,
        replied: row.first_reply_at !== null,
      },
      sources,
      savedViews,
    );
  }).length;
}
