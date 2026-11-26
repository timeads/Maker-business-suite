import type { SupabaseClient } from "@supabase/supabase-js";
import { BOOKINGS_MODULE } from "../bookings/config";
import { featureOpen } from "../module-access";
import { getAdminClient, withTenant } from "../supabase/admin";
import { TEXTS_KEY, parseTextSettings, textsAsked, type TextSettings } from "./config";

/**
 * A workspace's text settings, read with the service role for code with no
 * signed-in member (the worker, the public pages). Anything unreadable reads
 * as our defaults, which send nothing.
 */
export async function readTextSettings(
  tenantId: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<TextSettings> {
  const row = await withTenant(
    tenantId,
    async (scope) =>
      (
        await scope
          .select("configs", "body")
          .eq("module", BOOKINGS_MODULE)
          .eq("key", TEXTS_KEY)
          .maybeSingle()
      ).data as { body?: unknown } | null,
    admin,
  );
  return parseTextSettings(row?.body);
}

/** What the picker and the booking pages ask: whether to offer texts, and the words beside the tick. */
export type TextOffer = { asked: boolean; consent: string };

/**
 * Whether people booking should be offered texts: switched on with at least
 * one message, Twilio connected, and the plan allows it. Never throws: a
 * failed read offers nothing.
 */
export async function textOffer(
  tenantId: string,
  admin: SupabaseClient = getAdminClient(),
): Promise<TextOffer> {
  try {
    const settings = await readTextSettings(tenantId, admin);
    if (!textsAsked(settings)) return { asked: false, consent: "" };
    const connected = await withTenant(
      tenantId,
      async (scope) =>
        (
          (await scope.select("connections", "status").eq("provider", "twilio").maybeSingle())
            .data as { status?: string } | null
        )?.status === "active",
      admin,
    );
    if (!connected || !(await featureOpen(tenantId, "texts", admin))) {
      return { asked: false, consent: "" };
    }
    return { asked: true, consent: settings.consent_words };
  } catch {
    return { asked: false, consent: "" };
  }
}
