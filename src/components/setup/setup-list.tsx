import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { someNames, type SetupItem } from "@/lib/setup/items";
import { NotNowButton } from "./not-now-button";

/**
 * One tool's open setup items: what to do, why in one line, and a link
 * straight to the place that does it. "Not now" only where the person may
 * say it (owners and admins). An item only owners and admins can do says
 * so to anyone else (`canAct` false) instead of linking to a page they
 * can't use.
 */
export function SetupList({
  slug,
  tool,
  items,
  canSnooze,
  canAct = true,
}: {
  slug: string;
  tool: string;
  items: readonly SetupItem[];
  canSnooze: boolean;
  /** The person is an owner or admin who can change things. */
  canAct?: boolean;
}) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li
          key={item.id}
          className="border-border flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b py-3 first:pt-0 last:border-0 last:pb-0"
        >
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {item.title}
              {item.optional && <Badge tone="closed">Optional</Badge>}
            </p>
            {item.names && item.names.length > 0 && item.names.length <= 6 && (
              <p className="text-text-2 text-xs">{someNames(item.names)}</p>
            )}
            <p className="text-muted-foreground font-read text-sm">{item.why}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {item.managersOnly && !canAct ? (
              <span className="text-muted-foreground text-sm">Ask an owner or admin</span>
            ) : (
              <Link
                href={`/w/${slug}/${item.to}`}
                className="text-ochre-text text-sm font-medium underline-offset-2 hover:underline"
              >
                {item.action}
              </Link>
            )}
            {canSnooze && (
              <NotNowButton slug={slug} tool={tool} item={item.id} facts={item.facts} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
