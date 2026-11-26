/**
 * Every place a post can go, the network it belongs to, and that network's
 * own rules: ONE table, read by the composer before a post is scheduled and
 * mirrored in the database (`private.social_place_rule`, kept in step by
 * `tests/db/social-networks.test.ts`), where the same rules are checked again
 * when a post becomes scheduled. A new network is a new row here and there,
 * plus its sender; never a code path for one customer.
 *
 * A place is where on a network a post lands ("instagram" is the feed, or a
 * Reel for a video; a Story is its own place). For the newer networks the
 * place and the network share a name. Pure, so it can be tested.
 */

export const PLACES = ["facebook", "instagram", "instagram_story", "tiktok", "linkedin"] as const;
export type Place = (typeof PLACES)[number];

export const NETWORKS = ["facebook", "instagram", "tiktok", "linkedin"] as const;
export type Network = (typeof NETWORKS)[number];

/** The connection (provider) an account of each network posts through. */
export const NETWORK_PROVIDER: Record<Network, "meta" | "tiktok" | "linkedin"> = {
  facebook: "meta",
  instagram: "meta",
  tiktok: "tiktok",
  linkedin: "linkedin",
};

export type PlaceRule = {
  network: Network;
  /** For people: "Instagram Story". */
  label: string;
  /** Longest caption the place takes, in characters; null when it has no caption. */
  captionMax: number | null;
  /** Most hashtags the place takes in a caption; null for no limit of its own. */
  hashtagsMax: number | null;
  /** Most photos on one post; 0 when the place takes no photos at all. */
  photosMax: number;
  /** Takes a video (always one, on its own). */
  videoOk: boolean;
  /** Needs a photo or a video: words alone won't do. */
  needsMedia: boolean;
  /** Needs a video: photos won't do. */
  needsVideo: boolean;
};

/**
 * The rules, as each network states them, capped where the suite caps lower
 * (every caption box takes up to 2,200 characters, every post up to ten
 * photos). The figures for TikTok and LinkedIn were written from memory and
 * are listed in docs/tiktok-linkedin.md to check before going live.
 */
export const PLACE_RULES: Record<Place, PlaceRule> = {
  facebook: {
    network: "facebook",
    label: "Facebook",
    captionMax: 2200,
    hashtagsMax: null,
    photosMax: 10,
    videoOk: true,
    needsMedia: false,
    needsVideo: false,
  },
  instagram: {
    network: "instagram",
    label: "Instagram",
    captionMax: 2200,
    hashtagsMax: 30,
    photosMax: 10,
    videoOk: true,
    needsMedia: true,
    needsVideo: false,
  },
  instagram_story: {
    network: "instagram",
    label: "Instagram Story",
    captionMax: null,
    hashtagsMax: null,
    photosMax: 1,
    videoOk: true,
    needsMedia: true,
    needsVideo: false,
  },
  // Video only for now: TikTok takes photo posts only by fetching them from a
  // web address TikTok has verified as ours (docs/tiktok-linkedin.md).
  tiktok: {
    network: "tiktok",
    label: "TikTok",
    captionMax: 2200,
    hashtagsMax: null,
    photosMax: 0,
    videoOk: true,
    needsMedia: true,
    needsVideo: true,
  },
  linkedin: {
    network: "linkedin",
    label: "LinkedIn",
    captionMax: 3000,
    hashtagsMax: null,
    photosMax: 10,
    videoOk: true,
    needsMedia: false,
    needsVideo: false,
  },
};

export const NETWORK_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  linkedin: "LinkedIn",
};

export const isPlace = (value: unknown): value is Place =>
  typeof value === "string" && (PLACES as readonly string[]).includes(value);

export const isNetwork = (value: unknown): value is Network =>
  typeof value === "string" && (NETWORKS as readonly string[]).includes(value);

/** Which network a place is on. */
export const placeNetwork = (place: Place): Network => PLACE_RULES[place].network;

/** The places of one network, in the table's order. */
export const placesOf = (network: string): Place[] =>
  PLACES.filter((place) => PLACE_RULES[place].network === network);

/** Characters as the database counts them (code points, so an emoji is one). */
export const captionLength = (words: string) => [...words].length;

/** Hashtags in a caption, as the database counts them: a "#" at the start or after a space. */
export function hashtagCount(words: string): number {
  return (words.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
}

export type PlaceProblem =
  | { kind: "caption_long"; place: Place; max: number }
  | { kind: "hashtags"; place: Place; max: number }
  | { kind: "needs_video"; place: Place }
  | { kind: "needs_media"; place: Place }
  | { kind: "too_many_photos"; place: Place; max: number }
  | { kind: "no_video"; place: Place };

/**
 * What one place's rules say about a post: its words for that place, how
 * many photos and whether it carries a video. Empty when it fits.
 */
export function checkPlace(
  place: Place,
  post: { words: string; photos: number; video: boolean },
): PlaceProblem[] {
  const rule = PLACE_RULES[place];
  const problems: PlaceProblem[] = [];
  if (rule.captionMax !== null && captionLength(post.words) > rule.captionMax) {
    problems.push({ kind: "caption_long", place, max: rule.captionMax });
  }
  if (rule.captionMax !== null && rule.hashtagsMax !== null) {
    if (hashtagCount(post.words) > rule.hashtagsMax) {
      problems.push({ kind: "hashtags", place, max: rule.hashtagsMax });
    }
  }
  if (rule.needsVideo && !post.video) problems.push({ kind: "needs_video", place });
  else if (rule.needsMedia && !post.video && post.photos === 0) {
    problems.push({ kind: "needs_media", place });
  }
  if (post.video && !rule.videoOk) problems.push({ kind: "no_video", place });
  if (!post.video && post.photos > rule.photosMax) {
    problems.push({ kind: "too_many_photos", place, max: rule.photosMax });
  }
  return problems;
}

/** A problem in plain words. */
export function problemWords(problem: PlaceProblem): string {
  const label = PLACE_RULES[problem.place].label;
  switch (problem.kind) {
    case "caption_long":
      return `${label} takes captions of up to ${problem.max.toLocaleString("en-US")} characters. Shorten it, or give ${label} words of its own.`;
    case "hashtags":
      return `${label} takes up to ${problem.max} hashtags in a caption.`;
    case "needs_video":
      return `${label} needs a video. Pick one from your assets, or untick ${label}.`;
    case "needs_media":
      return `${label} needs a photo or a video.`;
    case "too_many_photos":
      return problem.max === 0
        ? `${label} takes a video, not photos. Untick ${label} for this post, or pick a video.`
        : `${label} takes up to ${problem.max} photo${problem.max === 1 ? "" : "s"} on one post.`;
    case "no_video":
      return `${label} doesn't take a video.`;
  }
}

/**
 * The database's refusal ("place_rule:needs_video:tiktok") in the same plain
 * words, or null when the message isn't one of these.
 */
export function placeRuleError(message: string): string | null {
  const found = /place_rule:([a-z_]+):([a-z_]+)/.exec(message);
  if (!found || !isPlace(found[2])) return null;
  const place = found[2];
  const rule = PLACE_RULES[place];
  switch (found[1]) {
    case "caption_long":
      return problemWords({ kind: "caption_long", place, max: rule.captionMax ?? 0 });
    case "hashtags":
      return problemWords({ kind: "hashtags", place, max: rule.hashtagsMax ?? 0 });
    case "needs_video":
      return problemWords({ kind: "needs_video", place });
    case "needs_media":
      return problemWords({ kind: "needs_media", place });
    case "too_many_photos":
      return problemWords({ kind: "too_many_photos", place, max: rule.photosMax });
    case "no_video":
      return problemWords({ kind: "no_video", place });
    case "no_account":
      return `Tick a ${NETWORK_LABELS[rule.network]} account for this post, or untick ${rule.label}.`;
    default:
      return null;
  }
}
