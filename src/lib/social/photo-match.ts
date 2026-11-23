/**
 * Choosing a photo from the workspace's assets to go with some words (a post's topic and
 * brief, or what an email is about). Deliberately simple, so the choice can always be explained
 * in one line: a photo is picked because one of its tags, or a word in its name, is in the text.
 *
 * Pure: it looks only at the tags and names it is given. Nothing is fetched or looked at.
 */

export type TaggedAsset = {
  id: string;
  title: string;
  tags: string[];
  /** "image/jpeg", "video/mp4", ... Only pictures are ever chosen. */
  mimeType: string;
};

export type PhotoMatch<T extends TaggedAsset = TaggedAsset> = {
  asset: T;
  /** The tag that matched, when one did. */
  tag: string | null;
  /** One short line a person can read: why this photo. */
  reason: string;
  score: number;
};

/** The logo for light backgrounds, and the one for dark. Never used as a content photo. */
export const LOGO_TAG = "logo";
export const LOGO_LIGHT_TAG = "logo-light";
const LOGO_TAGS = new Set([LOGO_TAG, LOGO_LIGHT_TAG]);
/** Tags that say what an asset is, not what it shows. They never count as a match. */
const HOUSE_TAGS = new Set(["designed", "banner"]);

// Words too common to mean a photo fits.
const SMALL_WORDS = new Set(
  "a about after all also an and any are as at be been but by can come for from get has have here how in into is it its just like more new not now of on one or our out over post so some than that the their them then there these this to up us was we what when which who will with you your email write make made update general studio".split(
    " ",
  ),
);

/** A word as it is compared: lower case, with a plain plural taken off ("workshops" is "workshop"). */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The words of a text that could match a tag: letters and digits, three or more, common words left out. */
export function matchWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 3 && !SMALL_WORDS.has(word));
  return new Set(words.map(stem));
}

const partsOf = (value: string) =>
  value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 3 && !SMALL_WORDS.has(part))
    .map(stem);

const isPicture = (asset: TaggedAsset) => asset.mimeType.startsWith("image/");
const isLogo = (asset: TaggedAsset) => asset.tags.some((tag) => LOGO_TAGS.has(tag.toLowerCase()));

/**
 * The photos that fit the text, best first. A tag counts when every word of it is in the text
 * (so "autumn sale" needs both); a word of the photo's name counts for less. Videos and logos are
 * never offered. Photos that tie stay in the order given, which is newest first.
 */
export function matchPhotos<T extends TaggedAsset>(
  assets: T[],
  text: string,
  options: { limit?: number; skip?: Iterable<string> } = {},
): PhotoMatch<T>[] {
  const words = matchWords(text);
  if (words.size === 0) return [];
  const skip = new Set(options.skip ?? []);
  const found: (PhotoMatch<T> & { order: number })[] = [];
  assets.forEach((asset, order) => {
    if (!isPicture(asset) || isLogo(asset) || skip.has(asset.id)) return;
    const tags = asset.tags
      .map((tag) => tag.toLowerCase().trim())
      .filter((tag) => tag && !HOUSE_TAGS.has(tag))
      .filter((tag) => {
        const parts = partsOf(tag);
        return parts.length > 0 && parts.every((part) => words.has(part));
      });
    const named = [...new Set(partsOf(asset.title))].filter((part) => words.has(part));
    const score = tags.length * 3 + named.length;
    if (score === 0) return;
    found.push({
      asset,
      tag: tags[0] ?? null,
      reason: tags.length
        ? `matched your tag: ${tags[0]}`
        : `matched its name: ${asset.title.trim().slice(0, 40)}`,
      score,
      order,
    });
  });
  return found
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, options.limit ?? 3)
    .map(({ order: _order, ...match }) => match);
}

/** The one photo to add without being asked, or null. */
export function pickPhoto<T extends TaggedAsset>(
  assets: T[],
  text: string,
  skip: Iterable<string> = [],
): PhotoMatch<T> | null {
  return matchPhotos(assets, text, { limit: 1, skip })[0] ?? null;
}

/**
 * The workspace's logo for a background: the asset tagged `logo`, or on a dark background the
 * one tagged `logo-light` when there is one. The newest of each is used.
 */
export function pickLogoAsset<T extends TaggedAsset>(assets: T[], onDark = false): T | null {
  const tagged = (wanted: string) =>
    assets.find(
      (asset) => isPicture(asset) && asset.tags.some((tag) => tag.toLowerCase() === wanted),
    ) ?? null;
  return (onDark ? tagged(LOGO_LIGHT_TAG) : null) ?? tagged(LOGO_TAG);
}
