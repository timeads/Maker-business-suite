import type { SetupItem } from "./items";

/**
 * The shop's connection as a checklist sees it, for the tools that read
 * everything from the shop (Stock, Shipping). Money keeps its own, which
 * also covers the books. Pure.
 */

/** A connection's state, as members may read it; null when there is none. */
export type ConnectionFact = {
  status: "active" | "needs_reconnect" | "disconnected";
  lastSyncedAt: string | null;
  lastError: string | null;
};

/** Hours after which the shop's last read counts as old. */
export const SHOP_OLD_AFTER_HOURS = 72;

/** A `connections` row (status, last_synced_at, last_error) as a fact. */
export function connectionFact(
  row: Record<string, unknown> | null | undefined,
): ConnectionFact | null {
  if (!row || typeof row.status !== "string") return null;
  const status = ["active", "needs_reconnect", "disconnected"].includes(row.status)
    ? (row.status as ConnectionFact["status"])
    : "disconnected";
  return {
    status,
    lastSyncedAt: typeof row.last_synced_at === "string" ? row.last_synced_at : null,
    lastError: typeof row.last_error === "string" && row.last_error ? row.last_error : null,
  };
}

/**
 * At most one item about the shop: connect it, connect it again, its last
 * read didn't finish, it hasn't been read yet, or not lately. Connecting and
 * reading again are for owners and admins.
 */
export function shopItems(
  fact: ConnectionFact | null,
  now: Date,
  opts: {
    /** What the tool reads from the shop, as one sentence. */
    what: string;
    /** The step these sit in. */
    step: string;
    /** Where "Read again" is, inside the workspace. */
    readAgain: string;
  },
): SetupItem[] {
  const base = { step: opts.step, managersOnly: true };
  if (!fact || fact.status === "disconnected") {
    return [
      {
        ...base,
        id: "shop.connect",
        title: "Connect your shop",
        why: opts.what,
        to: "connections",
        action: "Connect your shop",
        facts: "none",
      },
    ];
  }
  if (fact.status === "needs_reconnect") {
    return [
      {
        ...base,
        id: "shop.reconnect",
        title: "Your shop needs connecting again",
        why: `${opts.what} Until it's connected again, everything stops at the last read.`,
        to: "connections",
        action: "Connect it again",
        facts: fact.lastSyncedAt ?? "never",
      },
    ];
  }
  if (fact.lastError) {
    return [
      {
        ...base,
        id: "shop.failed",
        title: "The last read of your shop didn't finish",
        why: "What you see is from the read before it. Reading again usually sorts it out.",
        to: opts.readAgain,
        action: "Read again",
        facts: fact.lastSyncedAt ?? "never",
      },
    ];
  }
  const last = fact.lastSyncedAt ? Date.parse(fact.lastSyncedAt) : Number.NaN;
  if (!Number.isFinite(last)) {
    return [
      {
        ...base,
        id: "shop.first-read",
        title: "Your shop hasn't been read yet",
        why: "The first read brings in your items and orders. It starts by itself within the hour, or you can start it now.",
        to: opts.readAgain,
        action: "Read it now",
        facts: "never",
      },
    ];
  }
  if (now.getTime() - last > SHOP_OLD_AFTER_HOURS * 3600_000) {
    return [
      {
        ...base,
        id: "shop.old",
        title: "Your shop hasn't been read lately",
        why: "Everything here is only as fresh as the last read.",
        to: opts.readAgain,
        action: "Read again",
        facts: fact.lastSyncedAt ?? "never",
      },
    ];
  }
  return [];
}
