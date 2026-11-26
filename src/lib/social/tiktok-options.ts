import { z } from "zod";

/**
 * The choices TikTok asks a person to make for every post it publishes
 * directly (its "direct post" rules for apps): who can see it, whether
 * people may comment, duet and stitch, and whether it promotes a brand.
 * Kept per TikTok account on the post (`social_posts.target_options`, keyed
 * by account id), checked here with Zod and again by the database.
 *
 * Safe by default: nothing is shared with anyone until a person picks who
 * can see it, and comments, duets, stitches and the brand marks are off
 * until a person switches them on.
 */
export const TIKTOK_PRIVACY = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TikTokPrivacy = (typeof TIKTOK_PRIVACY)[number];

export const PRIVACY_LABELS: Record<TikTokPrivacy, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends (people you follow who follow you back)",
  FOLLOWER_OF_CREATOR: "Your followers",
  SELF_ONLY: "Only you",
};

export const tiktokOptionsSchema = z
  .object({
    /** Who can see it. Null until a person picks: a post can't be scheduled without it. */
    privacy_level: z.enum(TIKTOK_PRIVACY).nullable().default(null),
    allow_comment: z.boolean().default(false),
    allow_duet: z.boolean().default(false),
    allow_stitch: z.boolean().default(false),
    /** "Your brand": it promotes the business itself. */
    brand_organic: z.boolean().default(false),
    /** "Branded content": a paid partnership with another brand. */
    brand_content: z.boolean().default(false),
  })
  .strict();
export type TikTokOptions = z.infer<typeof tiktokOptionsSchema>;

export const DEFAULT_TIKTOK_OPTIONS: TikTokOptions = tiktokOptionsSchema.parse({});

/** A post's options for one account, or the safe defaults when there are none or they don't read. */
export function tiktokOptionsFor(all: unknown, accountId: string): TikTokOptions {
  const raw = (all && typeof all === "object" ? (all as Record<string, unknown>) : {})[accountId];
  const parsed = tiktokOptionsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_TIKTOK_OPTIONS;
}

/** What TikTok says this creator may choose right now ("creator info"). Nothing secret. */
export type CreatorChoices = {
  privacyOptions: TikTokPrivacy[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  /** Longest video they may post, in seconds, when TikTok said. */
  maxSeconds: number | null;
};

/**
 * Whether TikTok has audited (approved) this deployment's app for posting
 * that others can see. Until it has, TikTok accepts only posts that the
 * creator alone can see. Set `TIKTOK_APP_AUDITED=true` once TikTok says so.
 */
export const tiktokAudited = () => process.env.TIKTOK_APP_AUDITED === "true";

/** Who can see a post, among what TikTok allows this creator and this app right now. */
export function privacyChoices(
  creator: Pick<CreatorChoices, "privacyOptions"> | null,
  audited: boolean,
): TikTokPrivacy[] {
  const allowed = creator?.privacyOptions.length ? creator.privacyOptions : [...TIKTOK_PRIVACY];
  return audited ? allowed : allowed.filter((level) => level === "SELF_ONLY");
}

/**
 * What is wrong with one account's options before the post is scheduled, in
 * plain words, or null. The database checks the first three again.
 */
export function checkTikTokOptions(
  options: TikTokOptions,
  creator: CreatorChoices | null,
  audited: boolean,
): string | null {
  if (!options.privacy_level) return "Choose who can see it on TikTok.";
  if (!privacyChoices(creator, audited).includes(options.privacy_level)) {
    return audited
      ? "TikTok doesn't offer that choice of who can see it for this account. Pick another."
      : "TikTok only lets our app post videos that only you can see until TikTok has reviewed it. Choose “Only you”; you can change who sees it in the TikTok app afterwards.";
  }
  if (options.brand_content && options.privacy_level === "SELF_ONLY") {
    return "TikTok doesn't allow branded content to be private. Choose who can see it, or untick “Branded content”.";
  }
  return null;
}

/**
 * The options as TikTok's direct post takes them (`post_info`), with
 * anything the creator has switched off in TikTok kept off.
 */
export function tiktokPostInfo(
  options: TikTokOptions,
  creator: Pick<CreatorChoices, "commentDisabled" | "duetDisabled" | "stitchDisabled"> | null,
  title: string,
) {
  return {
    title,
    privacy_level: options.privacy_level ?? "SELF_ONLY",
    disable_comment: !options.allow_comment || Boolean(creator?.commentDisabled),
    disable_duet: !options.allow_duet || Boolean(creator?.duetDisabled),
    disable_stitch: !options.allow_stitch || Boolean(creator?.stitchDisabled),
    brand_organic_toggle: options.brand_organic,
    brand_content_toggle: options.brand_content,
  };
}

/** Reads TikTok's creator info answer into the choices we keep. Anything odd is left out. */
export function readCreatorChoices(raw: unknown): CreatorChoices {
  const data = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const options = Array.isArray(data.privacy_level_options)
    ? data.privacy_level_options.filter((level): level is TikTokPrivacy =>
        (TIKTOK_PRIVACY as readonly unknown[]).includes(level),
      )
    : [];
  const seconds = Number(data.max_video_post_duration_sec);
  return {
    privacyOptions: options,
    commentDisabled: data.comment_disabled === true,
    duetDisabled: data.duet_disabled === true,
    stitchDisabled: data.stitch_disabled === true,
    maxSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds) : null,
  };
}

/** The choices as the database keeps them on the account (`posting_options`). */
export const creatorChoicesRow = (choices: CreatorChoices) => ({
  privacy_level_options: choices.privacyOptions,
  comment_disabled: choices.commentDisabled,
  duet_disabled: choices.duetDisabled,
  stitch_disabled: choices.stitchDisabled,
  max_video_post_duration_sec: choices.maxSeconds,
});
