/**
 * The workspace's social accounts as people see them: one Facebook Page and
 * the Instagram account linked to it, per Page. Pure, so it can be tested.
 */

export type AccountRow = {
  id: string;
  network: string;
  platform_id: string;
  page_id: string | null;
  name: string | null;
  handle: string | null;
  brand_id: string;
  active: boolean;
  offered: boolean;
};

export const ACCOUNT_COLUMNS =
  "id, network, platform_id, page_id, name, handle, brand_id, active, offered";

export const NETWORK_LABELS: Record<string, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
};

/** "@handle" for an Instagram account, the Page's name for a Page. */
export function accountName(account: Pick<AccountRow, "handle" | "name" | "network">): string {
  if (account.handle) return `@${account.handle}`;
  return account.name ?? `${NETWORK_LABELS[account.network] ?? "An"} account`;
}

/** "Instagram · @handle". */
export const accountLabel = (account: Pick<AccountRow, "handle" | "name" | "network">) =>
  `${NETWORK_LABELS[account.network] ?? account.network} · ${accountName(account)}`;

/** Accounts grouped by the Page they go through, Pages in use first, each Page's Facebook row first. */
export function accountsByPage<T extends AccountRow>(
  accounts: readonly T[],
): { pageId: string; accounts: T[] }[] {
  const pages = new Map<string, T[]>();
  for (const account of accounts) {
    const key = account.page_id ?? account.id;
    pages.set(key, [...(pages.get(key) ?? []), account]);
  }
  return [...pages]
    .map(([pageId, list]) => ({
      pageId,
      accounts: [...list].sort(
        (a, b) => (a.network === "facebook" ? -1 : 0) - (b.network === "facebook" ? -1 : 0),
      ),
    }))
    .sort(
      (a, b) =>
        Number(b.accounts.some((x) => x.active)) - Number(a.accounts.some((x) => x.active)) ||
        (a.accounts[0].name ?? "").localeCompare(b.accounts[0].name ?? ""),
    );
}

/**
 * What is wrong with a set of choices before the database is asked, in
 * words, or null: no more accounts of one network in use than the plan
 * allows (counting the ones left as they are).
 */
export function checkAccountChoices(
  accounts: readonly Pick<AccountRow, "id" | "network" | "active">[],
  choices: readonly { id: string; active: boolean }[],
  limit: number,
): string | null {
  const after = new Map(accounts.map((account) => [account.id, account]));
  for (const choice of choices) {
    const account = after.get(choice.id);
    if (account) after.set(choice.id, { ...account, active: choice.active });
  }
  const counts = new Map<string, number>();
  for (const account of after.values()) {
    if (account.active) counts.set(account.network, (counts.get(account.network) ?? 0) + 1);
  }
  for (const [network, count] of counts) {
    if (count > limit) {
      return `Your plan uses up to ${limit} ${NETWORK_LABELS[network] ?? network} ${
        network === "facebook"
          ? limit === 1
            ? "Page"
            : "Pages"
          : limit === 1
            ? "account"
            : "accounts"
      } at a time. Untick one, or upgrade your plan.`;
    }
  }
  return null;
}

/** Which accounts a brand posts and answers as, in use only. */
export const brandAccounts = <T extends Pick<AccountRow, "brand_id" | "active">>(
  accounts: readonly T[],
  brandId: string | null,
): T[] => accounts.filter((account) => account.active && account.brand_id === brandId);
