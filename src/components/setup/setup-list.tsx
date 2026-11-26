import Link from "next/link";
import { someNames, type SetupItem } from "@/lib/setup/items";
import { NotNowButton } from "./not-now-button";

/**
 * One tool's open setup items: what to do, why in one line, and a link
 * straight to the place that does it. "Not now" only where the person may
 * say it (owners and admins).
 */
export function SetupList({
  slug,
  tool,
  items,
  canSnooze,
}: {
  slug: string;
  tool: string;
  items: readonly SetupItem[];
  canSnooze: boolean;
}) {
  return (
    <ul className="flex flex-col">
      {items.map((item) => (
        <li
          key={item.id}
          className="border-border flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b py-3 first:pt-0 last:border-0 last:pb-0"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{item.title}</p>
            {item.names && item.names.length > 0 && item.names.length <= 6 && (
              <p className="text-text-2 text-xs">{someNames(item.names)}</p>
            )}
            <p className="text-muted-foreground font-read text-sm">{item.why}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <Link
              href={`/w/${slug}/${item.to}`}
              className="text-ochre-text text-sm font-medium underline-offset-2 hover:underline"
            >
              {item.action}
            </Link>
            {canSnooze && (
              <NotNowButton slug={slug} tool={tool} item={item.id} facts={item.facts} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}
