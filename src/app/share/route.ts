import { randomUUID } from "node:crypto";
import { getUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { getAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { listMyTenants } from "@/lib/tenants";

/**
 * Where a phone's Share menu sends photos and videos. They are added to the
 * workspace's Assets, tagged "shared", and the person lands on them to name,
 * tag or file them. Signed-in members only; the same type and size limits as
 * any other upload.
 */
const TYPES: Record<string, { ext: string; max: number }> = {
  "image/jpeg": { ext: "jpg", max: 8 * 1024 * 1024 },
  "image/png": { ext: "png", max: 8 * 1024 * 1024 },
  "video/mp4": { ext: "mp4", max: 50 * 1024 * 1024 },
  "video/quicktime": { ext: "mov", max: 50 * 1024 * 1024 },
};

const go = (request: Request, path: string) =>
  new Response(null, { status: 303, headers: { Location: new URL(path, request.url).toString() } });

export async function POST(request: Request) {
  // A share comes from the phone itself, never from another website.
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return new Response("Not allowed", { status: 403 });
  }
  const user = await getUser();
  if (!user) return go(request, "/login?next=/app");
  if (!process.env.SUPABASE_SECRET_KEY) return go(request, "/app");

  // The first workspace of theirs that has Social and can take changes.
  let target: { id: string; slug: string } | null = null;
  for (const tenant of await listMyTenants()) {
    const entitlements = await getEntitlements(tenant.id);
    if (entitlements.can("module.social") && entitlements.canWrite) {
      target = tenant;
      break;
    }
  }
  if (!target) return go(request, "/app");

  let files: File[] = [];
  try {
    const form = await request.formData();
    files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  } catch {
    return go(request, `/w/${target.slug}/social/library`);
  }

  const admin = getAdminClient();
  let added = 0;
  const ids: string[] = [];
  for (const file of files.slice(0, 20)) {
    const kind = TYPES[file.type];
    if (!kind || file.size > kind.max) continue;
    const path = `${target.id}/${randomUUID()}.${kind.ext}`;
    const { error: uploadError } = await admin.storage
      .from("social")
      .upload(path, file, { contentType: file.type });
    if (uploadError) {
      console.error(`Shared file upload failed: ${uploadError.message}`);
      continue;
    }
    const { data, error } = await admin.rpc("register_social_asset", {
      p_tenant_id: target.id,
      p_storage_path: path,
      p_mime_type: file.type,
      p_bytes: file.size,
      p_created_by: user.id,
      p_folder_id: null,
      p_title: file.name.replace(/\.[^.]+$/, "").slice(0, 120),
    });
    if (error || !data) {
      await admin.storage.from("social").remove([path]);
      continue;
    }
    ids.push(data as string);
    added += 1;
  }
  if (ids.length > 0) {
    // Tagged so they are easy to find and file from the phone.
    const { error } = await (
      await createClient()
    ).rpc("sort_social_assets", {
      p_tenant_id: target.id,
      p_asset_ids: ids,
      p_move: false,
      p_folder_id: null,
      p_add_tags: ["shared"],
      p_hidden: null,
    });
    if (error) console.error(`Could not tag shared files: ${error.message}`);
  }
  return go(
    request,
    added > 0 ? `/w/${target.slug}/social/library?tag=shared` : `/w/${target.slug}/social/library`,
  );
}

/** Opening the address by hand just goes to the app. */
export function GET(request: Request) {
  return go(request, "/app");
}
