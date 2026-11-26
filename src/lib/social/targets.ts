import type { Channel } from "./publish";

/**
 * Where a post goes: each of its accounts, with the places of that
 * account's network. One target's answer is kept under
 * "<account id>:<place>" in the post's `results` (a post from before
 * accounts keeps its places' bare names). Pure, for the worker and the pages.
 */

/** An account a post goes to, as the worker reads it. Nothing secret. */
export type PostAccount = {
  id: string;
  network: string;
  platform_id: string;
  page_id: string | null;
  name: string | null;
  handle: string | null;
  tasks: string[] | null;
  active: boolean;
};

/** Which network a place is on. */
export const placeNetwork = (place: Channel): "facebook" | "instagram" =>
  place === "facebook" ? "facebook" : "instagram";

/** One target's name in a post's answers. */
export const targetKey = (accountId: string, place: Channel) => `${accountId}:${place}`;

/**
 * Where a post goes: each account with the places of its network, and the
 * key each answer is kept under. A post from before accounts goes to its
 * places by their bare names, through the connection's own Page.
 */
export function postTargets(
  post: { channels: Channel[]; account_ids?: string[] | null },
  accounts: readonly PostAccount[],
): { account: PostAccount | null; places: { place: Channel; key: string }[] }[] {
  const ids = post.account_ids ?? [];
  if (ids.length === 0) {
    return [{ account: null, places: post.channels.map((place) => ({ place, key: place })) }];
  }
  return ids.flatMap((id) => {
    const account = accounts.find((each) => each.id === id);
    if (!account) return [];
    const places = post.channels
      .filter((place) => placeNetwork(place) === account.network)
      .map((place) => ({ place, key: targetKey(id, place) }));
    return places.length > 0 ? [{ account, places }] : [];
  });
}

/** "Instagram (@handle)", "Facebook (Page name)": a target's name for people. */
export function targetLabel(key: string, accounts: readonly PostAccount[]): string {
  const [id, place] = key.includes(":") ? key.split(":") : [null, key];
  const where =
    place === "instagram_story"
      ? "Instagram Story"
      : place === "instagram"
        ? "Instagram"
        : "Facebook";
  const account = id ? accounts.find((each) => each.id === id) : undefined;
  const who = account ? (account.handle ? `@${account.handle}` : account.name) : null;
  return who ? `${where} (${who})` : where;
}
