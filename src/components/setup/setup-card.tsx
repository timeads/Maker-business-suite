import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { cardTitle, type SetupItem } from "@/lib/setup/items";
import { SetupList } from "./setup-list";

/**
 * The quiet card at the top of a tool's page: "3 things would make these
 * figures truer", folded until opened, and gone when nothing is left.
 */
export function SetupCard({
  slug,
  tool,
  items,
  canSnooze,
  setupHref,
  ending,
}: {
  slug: string;
  tool: string;
  items: readonly SetupItem[];
  canSnooze: boolean;
  /** The tool's guided setup, inside the workspace. */
  setupHref: string;
  ending?: string;
}) {
  if (items.length === 0) return null;
  return (
    <Card className="py-0">
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-6 py-4">
          <span className="text-sm font-semibold">{cardTitle(items.length, ending)}</span>
          <span className="text-muted-foreground text-xs">Show me</span>
        </summary>
        <CardContent className="flex flex-col gap-3 pb-5">
          <SetupList slug={slug} tool={tool} items={items} canSnooze={canSnooze} />
          <Link
            href={`/w/${slug}/${setupHref}`}
            className="text-muted-foreground w-fit text-sm hover:underline"
          >
            Or go through it step by step →
          </Link>
        </CardContent>
      </details>
    </Card>
  );
}
