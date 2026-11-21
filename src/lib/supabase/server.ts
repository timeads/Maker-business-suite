import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { env } from "@/lib/env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * It carries the signed-in user's session, so every query runs under RLS.
 */
export async function createClient() {
  // Session-backed data is per request, never prerendered. (The Supabase
  // client also reads the clock, which Next.js only allows at request time.)
  await connection();
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl, env.supabaseKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components can't set cookies; the proxy refreshes sessions.
        }
      },
    },
  });
}
