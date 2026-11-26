import Link from "next/link";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  canCheckAgain,
  shopPermissionWords,
  type ShopPermission,
} from "@/lib/connections/shop-permission";
import { CheckShopAgain } from "./check-shop-again";

const BADGE: Record<ShopPermission["state"], { tone: "good" | "waiting" | "bad"; words: string }> =
  {
    allowed: { tone: "good", words: "Allowed" },
    not_connected: { tone: "waiting", words: "Not connected" },
    reconnect: { tone: "bad", words: "Needs connecting again" },
    watch_only: { tone: "waiting", words: "Watch only" },
    asked_not_granted: { tone: "bad", words: "Shopify said no" },
    not_granted: { tone: "waiting", words: "Not allowed yet" },
  };

/**
 * Where the shop stands on one permission, in plain words, with what to do
 * next and a "Check again" press for owners and admins. Used by every
 * settings screen that leans on a Shopify permission, so they all say the
 * same thing (docs/shopify-permissions.md).
 */
export function ShopPermissionNote({
  slug,
  permission,
  what,
  canCheck,
  timezone,
  children,
}: {
  slug: string;
  permission: ShopPermission;
  /** Finishes "permission to …", e.g. "add tags to its orders". */
  what: string;
  /** Owners and admins on a plan that can still make changes. */
  canCheck: boolean;
  timezone: string;
  /** Anything else this screen offers in that state (a button to connect again). */
  children?: ReactNode;
}) {
  const { state, checkedAt } = permission;
  const words = shopPermissionWords(state, what);
  const badge = BADGE[state];
  const checked = checkedAt
    ? new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(checkedAt))
    : null;
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <Badge tone={badge.tone}>{badge.words}</Badge>
        {words.headline}
      </p>
      {words.next &&
        (state === "not_connected" || state === "reconnect" ? (
          <p className="text-muted-foreground">
            <Link href={`/w/${slug}/connections`} className="underline">
              {words.next}
            </Link>
          </p>
        ) : (
          <p className="text-muted-foreground">{words.next}</p>
        ))}
      {children}
      {canCheckAgain(permission) && (
        <div className="flex flex-col gap-1">
          {canCheck ? (
            <CheckShopAgain slug={slug} />
          ) : (
            <p className="text-muted-foreground">An owner or admin can check again.</p>
          )}
          <p className="text-muted-foreground text-xs">
            {checked
              ? `Last asked your shop ${checked}. It's asked again by itself about once an hour.`
              : "We haven't asked your shop yet. It's asked by itself about once an hour."}
          </p>
        </div>
      )}
    </div>
  );
}
