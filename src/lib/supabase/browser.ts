"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let client: SupabaseClient | null = null;

/**
 * Supabase in the browser, carrying the signed-in person's session. Used only
 * for live updates; reads and writes still go through the server.
 */
export function getBrowserClient(): SupabaseClient {
  client ??= createBrowserClient(env.supabaseUrl, env.supabaseKey);
  return client;
}
