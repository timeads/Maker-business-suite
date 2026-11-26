import { PLACE_RULES, placeNetwork, type Place } from "./networks";

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
  /** Which of its connection's logins posts as it (TikTok, LinkedIn). */
  login_id?: string | null;
  /** Its login has to be connected again first. */
  needs_login?: boolean | null;
  name: string | null;
  handle: string | null;
  tasks: string[] | null;
  active: boolean;
};

export { placeNetwork };

/** One target's name in a post's answers. */
export const targetKey = (accountId: string, place: Place) => `${accountId}:${place}`;

/**
 * Where a post goes: each account with the places of its network, and the
 * key each answer is kept under. A post from before accounts goes to its
 * places by their bare names, through the connection's own Page.
 */
export function postTargets(
  post: { channels: Place[]; account_ids?: string[] | null },
  accounts: readonly PostAccount[],
): { account: PostAccount | null; places: { place: Place; key: string }[] }[] {
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
  // An account id never holds a colon; a LinkedIn place name doesn't either.
  const cut = key.indexOf(":");
  const [id, place] = cut >= 0 ? [key.slice(0, cut), key.slice(cut + 1)] : [null, key];
  const where = PLACE_RULES[place as Place]?.label ?? "Facebook";
  const account = id ? accounts.find((each) => each.id === id) : undefined;
  const who = account ? (account.handle ? `@${account.handle}` : account.name) : null;
  return who ? `${where} (${who})` : where;
}
