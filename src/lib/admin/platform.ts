import { cache } from "react";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Whether the signed-in person runs the suite (a row in
 * `private.platform_admins`, added by hand; see docs/admin.md). Any doubt,
 * including a database that can't answer, is a no.
 */
export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  return !error && data === true;
});

/**
 * For the admin pages: signed-out visitors go to sign in; anyone else who
 * isn't a platform admin gets the ordinary "not found" page, so the area
 * doesn't announce itself. The database checks again on every call.
 */
export async function requirePlatformAdmin(next = "/admin") {
  const user = await requireUser(next);
  if (!(await isPlatformAdmin())) notFound();
  return user;
}
