import type { SupabaseClient } from "@supabase/supabase-js";
import { connectionFact } from "../setup/connection";
import { inboundDomain } from "./addresses";
import { AUTO_REPLIES_KEY, AUTO_REPLY_CHANNELS, parseAutoReplies } from "./auto-reply/config";
import { HELPDESK_MODULE, RULES_KEY, TEMPLATES_KEY, parseRules, parseTemplates } from "./config";
import { HELP_CENTRE_KEY, parseHelpCentre } from "./help-centre/config";
import { MANUAL_KEY } from "./manual/config";
import { DESK_SETTINGS_KEY, parseDeskSettings } from "./settings";
import type { HelpdeskSetupFacts } from "./setup";
import {
  CHANNELS_KEY,
  channelState,
  commentState,
  parseChannelSettings,
  type MetaConnectionFacts,
} from "./social/channels";

/** Every help desk setting the checklist looks at. */
export const SETUP_CONFIG_KEYS = [
  DESK_SETTINGS_KEY,
  TEMPLATES_KEY,
  RULES_KEY,
  CHANNELS_KEY,
  AUTO_REPLIES_KEY,
  MANUAL_KEY,
  HELP_CENTRE_KEY,
];

/** The Meta connection's facts from the columns members may read (as `connectionFacts` does). */
export function metaFacts(
  row: Record<string, unknown> | null | undefined,
): MetaConnectionFacts | null {
  if (!row) return null;
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    status: text(row.status),
    scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : null,
    pageName: text(row.display_name)?.split(" · ")[0] ?? null,
    instagramId: text(metadata.instagram_id),
    instagramUsername: text(metadata.instagram_username),
  };
}

/** What the inbox already read, so the panel's count costs two small reads. */
export type HelpdeskLoaded = {
  /** The help desk's settings by key (the ones in `SETUP_CONFIG_KEYS` it read). */
  configs: Map<string, unknown>;
  meta: MetaConnectionFacts | null;
};

/**
 * The facts the help desk checklist is worked out from, read as the member.
 * Mail arriving is one row at most ("has anything come in?"), never a
 * message. A part that fails is left out (counted as done), never an error.
 */
export async function loadHelpdeskSetupFacts(
  supabase: SupabaseClient,
  tenant: { id: string },
  opts: { loaded?: HelpdeskLoaded; now?: Date } = {},
): Promise<HelpdeskSetupFacts> {
  const now = opts.now ?? new Date();
  const address = Boolean(inboundDomain());
  const [configs, connections, instagram, inbound] = await Promise.all([
    opts.loaded
      ? Promise.resolve({
          data: [...opts.loaded.configs].map(([key, body]) => ({ key, body })),
          error: null,
        })
      : supabase
          .from("configs")
          .select("key, body")
          .eq("tenant_id", tenant.id)
          .eq("module", HELPDESK_MODULE)
          .in("key", SETUP_CONFIG_KEYS),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("provider, status, last_synced_at, last_error, scopes, display_name, metadata")
      .eq("tenant_id", tenant.id)
      .in("provider", opts.loaded ? ["shopify"] : ["shopify", "meta"]),
    opts.loaded
      ? Promise.resolve({ data: null, error: null })
      : supabase
          .from("social_accounts")
          .select("platform_id")
          .eq("tenant_id", tenant.id)
          .eq("network", "instagram")
          .eq("active", true)
          .limit(1),
    // Has an email ever come in? Social messages carry no sender address.
    address
      ? supabase
          .from("messages")
          .select("id")
          .eq("tenant_id", tenant.id)
          .eq("direction", "inbound")
          .not("from_email", "is", null)
          .limit(1)
      : Promise.resolve({ data: null, error: null }),
  ]);
  const saved = new Map(
    ((configs.data ?? []) as { key: string; body: unknown }[]).map((row) => [row.key, row.body]),
  );
  const rows = (connections.data ?? []) as Record<string, unknown>[];
  const shopRow = rows.find((row) => row.provider === "shopify") ?? null;
  const meta = (() => {
    if (opts.loaded) return opts.loaded.meta;
    const facts = metaFacts(rows.find((row) => row.provider === "meta"));
    // An Instagram account is "linked" when the workspace uses one, on any of its Pages.
    const used = ((instagram.data ?? []) as { platform_id: string }[])[0]?.platform_id ?? null;
    return facts && used ? { ...facts, instagramId: used } : facts;
  })();
  const channels = parseChannelSettings(saved.get(CHANNELS_KEY));
  const auto = parseAutoReplies(saved.get(AUTO_REPLIES_KEY));
  const desk = parseDeskSettings(saved.get(DESK_SETTINGS_KEY));
  const known = !configs.error;

  return {
    now,
    address,
    emailReceived:
      !address || inbound.error ? null : ((inbound.data ?? []) as unknown[]).length > 0,
    ownAddresses: known ? desk.own_addresses.length : 1,
    undoSeconds: known ? desk.undo_seconds : 5,
    templates: known ? parseTemplates(saved.get(TEMPLATES_KEY)).templates.length : 1,
    rules: known ? parseRules(saved.get(RULES_KEY)).rules.length : 1,
    social: {
      offered: Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET),
      messages: {
        instagram: channelState("instagram", channels, meta).state,
        facebook: channelState("facebook", channels, meta).state,
      },
      comments: {
        instagram: commentState("instagram", channels, meta).state,
        facebook: commentState("facebook", channels, meta).state,
      },
    },
    autoReplyOn: known ? AUTO_REPLY_CHANNELS.some((c) => auto[c].on) : true,
    manual: { saved: known ? saved.has(MANUAL_KEY) : true },
    helpCentre: { on: known ? parseHelpCentre(saved.get(HELP_CENTRE_KEY)).on : true },
    shop: connections.error ? null : connectionFact(shopRow),
  };
}
