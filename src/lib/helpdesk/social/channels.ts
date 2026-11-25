import { z } from "zod";
import { FEATURE_SCOPES } from "../../connections/meta-access";

/**
 * Where a conversation comes from. Email is the help desk's first channel;
 * Instagram and Facebook messages arrive through the workspace's Meta
 * connection (the same one Social posts with) once a manager switches
 * "Messages in the help desk" on.
 */
export const SOCIAL_CHANNELS = ["instagram", "facebook"] as const;
export type SocialChannel = (typeof SOCIAL_CHANNELS)[number];
export const CHANNELS = ["email", ...SOCIAL_CHANNELS] as const;
export type Channel = (typeof CHANNELS)[number];

export const isSocialChannel = (value: unknown): value is SocialChannel =>
  SOCIAL_CHANNELS.some((channel) => channel === value);
export const isChannel = (value: unknown): value is Channel =>
  CHANNELS.some((channel) => channel === value);

export const CHANNEL_LABELS: Record<Channel, string> = {
  email: "Email",
  instagram: "Instagram",
  facebook: "Facebook",
};

/** The `object` Meta's webhook names for each channel. */
export const channelOfObject = (object: unknown): SocialChannel | null =>
  object === "instagram" ? "instagram" : object === "page" ? "facebook" : null;

/**
 * The permissions messages need. They are requested only when a manager
 * switches messages on; what Meta really granted is recorded on the
 * connection and checked before anything is read or sent.
 */
export const MESSAGING_SCOPES = FEATURE_SCOPES.messages;

/** Whether the connection's granted permissions cover a channel. */
export function scopesAllow(channel: SocialChannel, scopes: readonly string[] | null): boolean {
  const has = (scope: string) => (scopes ?? []).includes(scope);
  if (!has("pages_manage_metadata")) return false;
  return channel === "facebook"
    ? has("pages_messaging")
    : has("instagram_manage_messages") && has("instagram_basic");
}

/**
 * What a workspace has switched on (`configs`, module "helpdesk", key
 * "channels"). Everything is off until a manager says otherwise.
 */
export const CHANNELS_KEY = "channels";
/**
 * Which comments start a conversation:
 *  - "all": every comment with words or a picture.
 *  - "skip_noise" (the usual choice): not the ones that are only emoji, a
 *    tagged friend or a one-word cheer. On a conversation already going,
 *    those are still kept.
 *  - "matching": only a comment with a question mark or one of the
 *    workspace's own words in it.
 */
export const COMMENT_FILTERS = ["all", "skip_noise", "matching"] as const;
export type CommentFilter = (typeof COMMENT_FILTERS)[number];
export const channelSettingsSchema = z.object({
  version: z.literal(1),
  instagram: z.boolean().default(false),
  facebook: z.boolean().default(false),
  /**
   * Only for a Meta app that has been approved for the Human Agent feature:
   * lets a person answer up to seven days after the customer's last message.
   * Without that approval Meta refuses such replies, so this stays off.
   */
  human_agent: z.boolean().default(false),
  /** Comments on the business's own posts, one platform at a time. */
  instagram_comments: z.boolean().default(false),
  facebook_comments: z.boolean().default(false),
  comment_filter: z.enum(COMMENT_FILTERS).default("skip_noise"),
  /** The workspace's own words: a comment with one of them is always worth a conversation. */
  comment_words: z.array(z.string().trim().min(2).max(40)).max(30).default([]),
});
export type ChannelSettings = z.infer<typeof channelSettingsSchema>;
export const DEFAULT_CHANNEL_SETTINGS: ChannelSettings = {
  version: 1,
  instagram: false,
  facebook: false,
  human_agent: false,
  instagram_comments: false,
  facebook_comments: false,
  comment_filter: "skip_noise",
  comment_words: [],
};
export function parseChannelSettings(body: unknown): ChannelSettings {
  const parsed = channelSettingsSchema.safeParse(body);
  return parsed.success ? parsed.data : DEFAULT_CHANNEL_SETTINGS;
}

/** What the Meta connection says about itself (never anything secret). */
export type MetaConnectionFacts = {
  status: string | null;
  scopes: string[] | null;
  pageName: string | null;
  instagramId: string | null;
  instagramUsername: string | null;
};

export type ChannelState =
  | "on"
  /** Switched on, but the connection can't carry it (not connected, needs reconnecting, permission missing). */
  | "blocked"
  | "off";

/** Where each channel stands, for Settings, the menu and the reply box. */
export function channelState(
  channel: SocialChannel,
  settings: ChannelSettings,
  connection: MetaConnectionFacts | null,
): { state: ChannelState; why: string | null } {
  if (!settings[channel]) return { state: "off", why: null };
  if (!connection || connection.status === "disconnected") {
    return { state: "blocked", why: "Facebook & Instagram isn't connected." };
  }
  if (connection.status !== "active") {
    return { state: "blocked", why: "The Facebook & Instagram connection needs reconnecting." };
  }
  if (!scopesAllow(channel, connection.scopes)) {
    return {
      state: "blocked",
      why: "Facebook didn't give permission to read and answer messages. Switch it on again and leave every permission ticked.",
    };
  }
  if (channel === "instagram" && !connection.instagramId) {
    return {
      state: "blocked",
      why: "No Instagram professional account is linked to the connected Page.",
    };
  }
  return { state: "on", why: null };
}

/**
 * Whether the connection's granted permissions let comments on a platform
 * come in. (The database asks the same question in `meta_comment_channel`.)
 */
export function commentScopesAllow(
  channel: SocialChannel,
  scopes: readonly string[] | null,
): boolean {
  const has = (scope: string) => (scopes ?? []).includes(scope);
  if (!has("pages_manage_metadata") || !has("pages_read_engagement")) return false;
  return channel === "facebook"
    ? has("pages_read_user_content")
    : has("instagram_manage_comments") && has("instagram_basic");
}

/** What the team may do with a comment, by what Facebook granted. */
export function commentAbilities(channel: SocialChannel, scopes: readonly string[] | null) {
  const has = (scope: string) => (scopes ?? []).includes(scope);
  const manage =
    channel === "facebook" ? has("pages_manage_engagement") : has("instagram_manage_comments");
  return {
    /** A public reply under the comment. */
    reply: manage,
    /** Hide, show again, delete. */
    moderate: manage,
    /** The one private message about a comment rides on the messaging permissions. */
    privately:
      has("pages_messaging") && (channel === "facebook" || has("instagram_manage_messages")),
  };
}

/** Where comments on each platform stand, for Settings and the reply box. */
export function commentState(
  channel: SocialChannel,
  settings: ChannelSettings,
  connection: MetaConnectionFacts | null,
): { state: ChannelState; why: string | null } {
  if (!settings[`${channel}_comments`]) return { state: "off", why: null };
  if (!connection || connection.status === "disconnected") {
    return { state: "blocked", why: "Facebook & Instagram isn't connected." };
  }
  if (connection.status !== "active") {
    return { state: "blocked", why: "The Facebook & Instagram connection needs reconnecting." };
  }
  if (!commentScopesAllow(channel, connection.scopes)) {
    return {
      state: "blocked",
      why: "Facebook didn't give permission to read comments. Allow comments again and leave every permission ticked.",
    };
  }
  if (channel === "instagram" && !connection.instagramId) {
    return {
      state: "blocked",
      why: "No Instagram professional account is linked to the connected Page.",
    };
  }
  return { state: "on", why: null };
}

/**
 * How much one message can hold. Instagram counts bytes of UTF-8 (1,000);
 * Messenger counts characters (2,000).
 */
export const TEXT_LIMITS: Record<SocialChannel, { max: number; unit: "bytes" | "characters" }> = {
  instagram: { max: 1000, unit: "bytes" },
  facebook: { max: 2000, unit: "characters" },
};

/**
 * How long a public reply to a comment may be. These are our own caps (an
 * Instagram comment is the length of a caption; Facebook's are longer than
 * anyone should answer with): Meta's documentation gives no figure, and if
 * Meta refuses a reply its own words are shown.
 */
export const COMMENT_LIMITS: Record<SocialChannel, { max: number; unit: "characters" }> = {
  instagram: { max: 2200, unit: "characters" },
  facebook: { max: 8000, unit: "characters" },
};

/** How much of the limit some words use, in the unit that channel counts in. */
export function textSize(channel: SocialChannel, text: string): number {
  return TEXT_LIMITS[channel].unit === "bytes"
    ? new TextEncoder().encode(text).length
    : [...text].length;
}

export const textFits = (channel: SocialChannel, text: string): boolean =>
  textSize(channel, text) <= TEXT_LIMITS[channel].max;

/** Pictures a reply can carry: Meta takes PNG and JPEG up to 8 MB each. */
export const MAX_SOCIAL_IMAGES = 3;
export const MAX_SOCIAL_IMAGE_BYTES = 8 * 1024 * 1024;
export const SOCIAL_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;

/** What is wrong with the pictures picked for a message, in words, or null. */
export function socialFilesProblem(
  files: { name: string; size: number; type: string }[],
): string | null {
  if (files.length > MAX_SOCIAL_IMAGES) {
    return `A message can carry up to ${MAX_SOCIAL_IMAGES} pictures.`;
  }
  const wrong = files.find(
    (file) => !SOCIAL_IMAGE_TYPES.some((type) => type === file.type.toLowerCase()),
  );
  if (wrong)
    return `“${wrong.name}” isn't a JPEG or PNG picture, which is all a message can carry.`;
  const big = files.find((file) => file.size > MAX_SOCIAL_IMAGE_BYTES);
  if (big) return `“${big.name}” is too big to send (8 MB at most).`;
  return null;
}

/** "@handle" for Instagram, else the name Meta gave, else a plain stand-in. */
export function personLabel(
  channel: Channel,
  contact: { name?: string | null; handle?: string | null; email?: string | null } | null,
): string {
  if (channel === "email") return contact?.name ?? contact?.email ?? "Unknown sender";
  if (contact?.handle) return `@${contact.handle}`;
  return contact?.name ?? `${CHANNEL_LABELS[channel]} user`;
}

const HANDLE = /^[A-Za-z0-9._]{1,30}$/;
/** An Instagram username as Instagram writes them, or null. Never trusted as part of a link otherwise. */
export const tidyHandle = (raw: unknown): string | null => {
  const text = typeof raw === "string" ? raw.trim().replace(/^@/, "") : "";
  return HANDLE.test(text) ? text : null;
};

/** The person's public profile, for a plain link. Only Instagram has one we can name. */
export const profileUrl = (channel: Channel, handle: string | null | undefined): string | null => {
  const tidy = tidyHandle(handle);
  return channel === "instagram" && tidy ? `https://www.instagram.com/${tidy}/` : null;
};
