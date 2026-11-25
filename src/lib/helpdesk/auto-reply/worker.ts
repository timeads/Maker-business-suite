import type { SupabaseClient } from "@supabase/supabase-js";
import { withTenant } from "../../supabase/admin";
import { HELPDESK_MODULE } from "../config";
import { textToRich } from "../rich";
import { DESK_SETTINGS_KEY, parseDeskSettings } from "../settings";
import { CHANNELS_KEY, isChannel, parseChannelSettings, textFits } from "../social/channels";
import { AUTO_REPLIES_KEY, parseAutoReplies, type AutoReplies } from "./config";
import { isOwnAddress, shouldAutoReply, type AutoReplySkip } from "./rules";

/**
 * The worker's side of the automatic first reply: once an inbound message
 * has been filed, decide in code whether it gets one (`shouldAutoReply`),
 * and if so take the claim in the database and put the saved words in the
 * outbox every reply uses. The outbox sends it; nothing is sent from here.
 *
 * FIXED WORDS ONLY. This folder imports no AI helper and makes no model
 * call (`guard.test.ts` reads the source to keep it so): what goes out is
 * what an owner or admin typed in Settings, with two placeholders filled in.
 */

export type AutoReplyFactsRow = {
  channel: string;
  ticket_id: string;
  ticket_kind: string;
  shelf: string | null;
  direction: string;
  message_kind: string;
  removed: boolean;
  received_at: string;
  contact_name: string | null;
  reply_to_email: string | null;
  last_auto_reply_at: string | null;
  team_answered_since: boolean;
  business_name: string;
  time_zone: string;
};

export type AutoReplyInput = {
  tenantId: string;
  /** Our id for the inbound message that was just filed. */
  messageId: string;
  /** Instagram and Facebook: it came on Meta's standby list. */
  standby?: boolean;
  /** Email: what its headers said, worked out when it was read. */
  mail?: { automated: boolean; fromEmail: string };
};

export type AutoReplyDeps = {
  now(): number;
  /** The help desk is part of the workspace's plan and the workspace isn't read-only. */
  moduleOpen(tenantId: string): Promise<boolean>;
  settings(
    tenantId: string,
  ): Promise<{ autoReplies: AutoReplies; takeControl: boolean; ownAddresses: string[] }>;
  facts(tenantId: string, messageId: string): Promise<AutoReplyFactsRow | null>;
  /** Takes the claim and queues the reply. Returns the database's one-word answer. */
  claim(args: {
    tenantId: string;
    messageId: string;
    variant: "usual" | "away";
    payload: Record<string, unknown>;
    summary: Record<string, unknown>;
    quietHours: number;
  }): Promise<string>;
  /** Our inbound mail domain, when email is set up here. */
  mailDomain: string | null;
};

export type AutoReplyOutcome =
  | `queued ${"usual" | "away"}`
  | AutoReplySkip
  | "plan"
  | "unknown"
  | "too_long"
  | "no_address"
  | "duplicate";

/**
 * Looks at one filed message and, when the rules say so, queues the
 * automatic reply. Returns what happened in a word, for the worker's log
 * (never the message's words, and never who it was from).
 */
export async function considerAutoReply(
  input: AutoReplyInput,
  deps: AutoReplyDeps,
): Promise<AutoReplyOutcome> {
  const settings = await deps.settings(input.tenantId);
  const { autoReplies } = settings;
  // Nothing switched on: the usual case, and no reason to read anything else.
  if (!autoReplies.instagram.on && !autoReplies.facebook.on && !autoReplies.email.on) return "off";
  const facts = await deps.facts(input.tenantId, input.messageId);
  if (!facts || !isChannel(facts.channel)) return "unknown";
  const channel = facts.channel;
  if (!autoReplies[channel].on) return "off";
  if (!(await deps.moduleOpen(input.tenantId))) return "plan";

  const fromEmail = (input.mail?.fromEmail ?? facts.reply_to_email ?? "").trim().toLowerCase();
  const decision = shouldAutoReply(autoReplies, {
    channel,
    ticketKind: facts.ticket_kind,
    direction: facts.direction,
    messageKind: facts.message_kind,
    removed: facts.removed,
    shelf: facts.shelf,
    receivedAt: Date.parse(facts.received_at),
    now: deps.now(),
    lastAutoReplyAt: facts.last_auto_reply_at ? Date.parse(facts.last_auto_reply_at) : null,
    teamAnsweredSince: facts.team_answered_since,
    standby: input.standby === true,
    takeControl: settings.takeControl,
    // An email we know nothing about is treated as a machine's: better silent than a loop.
    automatedMail: channel === "email" && (input.mail?.automated ?? true),
    fromOwnAddress:
      channel === "email" &&
      isOwnAddress(fromEmail, { domain: deps.mailDomain, addresses: settings.ownAddresses }),
    timeZone: facts.time_zone,
    businessName: facts.business_name,
    contactName: facts.contact_name,
  });
  if (!decision.send) return decision.reason;

  const doc = textToRich(decision.text);
  const preview = decision.text.replace(/\s+/g, " ").slice(0, 200);
  let payload: Record<string, unknown>;
  let summary: Record<string, unknown>;
  if (channel === "email") {
    if (!/^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/.test(fromEmail)) return "no_address";
    // Only ever to the person who wrote: never to the others copied in.
    payload = {
      kind: "reply",
      to: [fromEmail],
      cc: [],
      bcc: [],
      doc,
      format: null,
      then: "keep",
      files: [],
    };
    summary = { kind: "reply", to: [fromEmail], preview };
  } else {
    if (!textFits(channel, decision.text)) return "too_long";
    payload = { kind: "social", channel, doc, then: "keep", files: [], via: "message" };
    summary = {
      kind: "social",
      channel,
      via: "message",
      to: facts.contact_name ? [facts.contact_name] : [],
      preview,
    };
  }
  const result = await deps.claim({
    tenantId: input.tenantId,
    messageId: input.messageId,
    variant: decision.variant,
    payload,
    summary,
    quietHours: autoReplies.quiet_hours,
  });
  if (result === "queued") return `queued ${decision.variant}`;
  return (
    ["duplicate", "not_a_message", "shelved", "answered", "quiet"].includes(result)
      ? result
      : "unknown"
  ) as AutoReplyOutcome;
}

/** The real thing: settings read under the workspace's name, facts and the claim from the database. */
export function autoReplyDeps(
  admin: SupabaseClient,
  extra: Pick<AutoReplyDeps, "moduleOpen" | "mailDomain">,
): AutoReplyDeps {
  return {
    ...extra,
    now: Date.now,
    settings: (tenantId) =>
      withTenant(
        tenantId,
        async (scope) => {
          const { data } = await scope
            .select("configs", "key, body")
            .eq("module", HELPDESK_MODULE)
            .in("key", [AUTO_REPLIES_KEY, CHANNELS_KEY, DESK_SETTINGS_KEY]);
          const rows = (data ?? []) as unknown as { key: string; body: unknown }[];
          const body = (key: string) => rows.find((row) => row.key === key)?.body;
          return {
            autoReplies: parseAutoReplies(body(AUTO_REPLIES_KEY)),
            takeControl: parseChannelSettings(body(CHANNELS_KEY)).take_control,
            ownAddresses: parseDeskSettings(body(DESK_SETTINGS_KEY)).own_addresses,
          };
        },
        admin,
      ),
    async facts(tenantId, messageId) {
      const { data, error } = await admin.rpc("auto_reply_facts", {
        p_tenant_id: tenantId,
        p_message_id: messageId,
      });
      if (error) throw new Error(`could not read a message's facts: ${error.message}`);
      return (data as AutoReplyFactsRow[] | null)?.[0] ?? null;
    },
    async claim(args) {
      const { data, error } = await admin.rpc("claim_auto_reply", {
        p_tenant_id: args.tenantId,
        p_message_id: args.messageId,
        p_variant: args.variant,
        p_payload: args.payload,
        p_summary: args.summary,
        p_quiet_hours: args.quietHours,
      });
      if (error) throw new Error(`could not queue an automatic reply: ${error.message}`);
      return String((data as { result?: unknown } | null)?.result ?? "unknown");
    },
  };
}
