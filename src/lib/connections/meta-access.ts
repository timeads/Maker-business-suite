/**
 * What a workspace's Facebook & Instagram connection is for, and the
 * permissions each use needs. Facebook Login refuses a whole login ("Invalid
 * Scopes") when it is asked for a permission the Meta app doesn't have, so a
 * login asks only for what the workspace is switching on, plus what the
 * connection was already granted. Nothing here is asked for by default except
 * posting from the Connections page, which is what that button has always
 * meant. What Facebook really granted is recorded in the connection's
 * `scopes`, and every feature checks those.
 */
export const META_FEATURES = [
  "posting",
  "messages",
  "facebook_comments",
  "instagram_comments",
] as const;
export type MetaFeature = (typeof META_FEATURES)[number];

/**
 * The permissions behind each use. `pages_show_list` is how the Page is
 * found at all; the rest follow Meta's permissions reference (each
 * permission's own dependencies are listed with it, so a login never asks
 * for one without the other).
 */
export const FEATURE_SCOPES: Record<MetaFeature, readonly string[]> = {
  /** Social: publishing to the Page and its Instagram account. */
  posting: [
    "pages_show_list",
    "pages_read_engagement",
    "pages_manage_posts",
    "instagram_basic",
    "instagram_content_publish",
  ],
  /** Help desk: Messenger and Instagram messages. (`business_management` is a listed dependency.) */
  messages: [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
    "pages_read_engagement",
    "business_management",
  ],
  /** Help desk: comments on the Page's posts, read, answered, hidden and deleted. */
  facebook_comments: [
    "pages_show_list",
    "pages_manage_metadata",
    "pages_read_engagement",
    "pages_read_user_content",
    "pages_manage_engagement",
  ],
  /** Help desk: comments on the Instagram account's posts and reels. */
  instagram_comments: [
    "pages_show_list",
    "pages_manage_metadata",
    "pages_read_engagement",
    "instagram_basic",
    "instagram_manage_comments",
  ],
};

export const isMetaFeature = (value: unknown): value is MetaFeature =>
  META_FEATURES.some((feature) => feature === value);

/** A comma list of features ("messages,posting") as the features it names, in our order. */
export function parseFeatures(raw: string | undefined | null): MetaFeature[] {
  const asked = new Set((raw ?? "").split(",").map((part) => part.trim()));
  return META_FEATURES.filter((feature) => asked.has(feature));
}

/** Every permission a set of features needs, each once, in a steady order. */
export function scopesFor(features: readonly MetaFeature[]): string[] {
  return [...new Set(features.flatMap((feature) => FEATURE_SCOPES[feature]))];
}

/**
 * Which uses a connection's granted permissions were for. Told by the one or
 * two permissions only that use asks for, so a connection is never taken to
 * have something it wasn't given.
 */
export function featuresOf(scopes: readonly string[] | null | undefined): MetaFeature[] {
  const has = (scope: string) => (scopes ?? []).includes(scope);
  const marks: Record<MetaFeature, boolean> = {
    posting: has("pages_manage_posts") || has("instagram_content_publish"),
    messages: has("pages_messaging") || has("instagram_manage_messages"),
    facebook_comments: has("pages_manage_engagement") || has("pages_read_user_content"),
    instagram_comments: has("instagram_manage_comments"),
  };
  return META_FEATURES.filter((feature) => marks[feature]);
}

/**
 * What one login asks for: what the screen that started it wants (`access`),
 * and what the connection already had (`kept`, worked out by the server from
 * the scopes on record, never from the form). With neither, it is the
 * Connections page's own button, which connects for posting.
 */
export function requestedFeatures(input: Record<string, string | undefined>): MetaFeature[] {
  const wanted = new Set([...parseFeatures(input.access), ...parseFeatures(input.kept)]);
  const features = META_FEATURES.filter((feature) => wanted.has(feature));
  return features.length > 0 ? features : ["posting"];
}

/** Whether the granted permissions let Social publish to each place. */
export function canPost(
  where: "facebook" | "instagram",
  scopes: readonly string[] | null | undefined,
): boolean {
  const has = (scope: string) => (scopes ?? []).includes(scope);
  return where === "facebook"
    ? has("pages_manage_posts")
    : has("instagram_content_publish") && has("instagram_basic");
}

/** What an account is used for, as far as Meta's per-Page tasks go. */
export type AccountUse = "posting" | "messages" | "comments";

/**
 * Meta grants permissions to the login, but says per Page what the person
 * may do there (`tasks` on each Page: MANAGE, CREATE_CONTENT, MESSAGING,
 * MODERATE, ...). An account is used for something only where its Page's
 * tasks allow it; where Meta didn't say (an account from before tasks were
 * read), the permissions alone decide. The database's twin is
 * `private.meta_tasks_allow`, kept in step by a test.
 */
export function accountAllows(
  use: AccountUse,
  tasks: readonly string[] | null | undefined,
): boolean {
  if (!tasks) return true;
  if (tasks.includes("MANAGE")) return true;
  const needs: Record<AccountUse, string> = {
    posting: "CREATE_CONTENT",
    messages: "MESSAGING",
    comments: "MODERATE",
  };
  return tasks.includes(needs[use]);
}

/** Whether an account can be posted to: the login's permission for its network, and its Page's tasks. */
export function canPostAs(
  account: { network: string; tasks?: readonly string[] | null },
  scopes: readonly string[] | null | undefined,
): boolean {
  if (account.network !== "facebook" && account.network !== "instagram") return false;
  return canPost(account.network, scopes) && accountAllows("posting", account.tasks);
}
