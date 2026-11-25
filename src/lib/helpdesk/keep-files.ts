import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { withTenant } from "../supabase/admin";
import { FILES_BUCKET, planFiles, storagePath, type FilePlan, type IncomingFile } from "./files";

/**
 * Keeps a message's files: decides what stays (`planFiles`), puts those in
 * the private bucket under a name of our own, and lists every file, kept or
 * not, on the message. Server only, with the service role, always naming the
 * workspace. Safe to call again for the same message: the second call finds
 * the list already written and does nothing.
 */
export async function keepMessageFiles(
  admin: SupabaseClient,
  where: { tenantId: string; ticketId: string; messageId: string },
  files: IncomingFile[],
): Promise<{ kept: number; notKept: number }> {
  const none = { kept: 0, notKept: 0 };
  if (files.length === 0) return none;
  const already = await withTenant(
    where.tenantId,
    async (scope) => {
      const { data, error } = await scope
        .select("message_attachments", "id")
        .eq("message_id", where.messageId)
        .limit(1);
      if (error) throw new Error(`could not look for a message's files: ${error.message}`);
      return (data ?? []).length > 0;
    },
    admin,
  );
  if (already) return none;

  const { data: used, error: usedError } = await admin.rpc("attachment_bytes_today", {
    p_tenant_id: where.tenantId,
  });
  if (usedError) throw new Error(`could not read today's file allowance: ${usedError.message}`);

  const bucket = admin.storage.from(FILES_BUCKET);
  const uploaded: string[] = [];
  const rows: Record<string, unknown>[] = [];
  for (const file of planFiles(files, Number(used ?? 0))) {
    let plan: FilePlan = file;
    let path: string | null = null;
    if (plan.keep) {
      path = storagePath(where.tenantId, where.ticketId, where.messageId, randomUUID());
      const { error } = await bucket.upload(path, plan.bytes, {
        contentType: plan.type,
        upsert: false,
      });
      if (error) {
        // The conversation still says a file came; only the file itself is missing.
        console.error(`could not keep a help desk file: ${error.message}`);
        plan = { ...plan, keep: false, reason: "failed" };
        path = null;
      } else uploaded.push(path);
    }
    rows.push({
      name: plan.name,
      type: plan.type,
      size: plan.size,
      content_id: plan.contentId,
      path,
      state: plan.keep ? "kept" : "not_kept",
      reason: plan.keep ? null : plan.reason,
    });
  }

  const { data: written, error } = await admin.rpc("record_message_attachments", {
    p_tenant_id: where.tenantId,
    p_message_id: where.messageId,
    p_files: rows,
  });
  if (error || !written) {
    // Nothing was listed (or someone else listed them first): don't leave files nobody points at.
    if (uploaded.length > 0) await bucket.remove(uploaded);
    if (error) throw new Error(`could not list a message's files: ${error.message}`);
    return none;
  }
  return { kept: uploaded.length, notKept: rows.length - uploaded.length };
}

/** Takes files out of storage whose rows are gone (deleted conversations, forgotten customers). */
export async function removeQueuedFiles(admin: SupabaseClient): Promise<number> {
  const { data, error } = await admin.rpc("claim_attachment_removals", { p_limit: 100 });
  if (error) throw new Error(`Could not claim files to remove: ${error.message}`);
  const paths = ((data ?? []) as unknown[]).map(String).filter(Boolean);
  if (paths.length === 0) return 0;
  const { error: removeError } = await admin.storage.from(FILES_BUCKET).remove(paths);
  if (removeError) throw new Error(`Could not remove help desk files: ${removeError.message}`);
  const { error: doneError } = await admin.rpc("finish_attachment_removals", { p_paths: paths });
  if (doneError) throw new Error(`Could not clear removed files: ${doneError.message}`);
  return paths.length;
}
