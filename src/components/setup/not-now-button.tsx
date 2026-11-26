"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { setNotNow } from "@/lib/setup/actions";

/**
 * "Not now" on one checklist item (or "Show it again" with `back`). Kept
 * with the item's facts, so it comes back by itself when they change.
 */
export function NotNowButton({
  slug,
  tool,
  item,
  facts,
  back = false,
}: {
  slug: string;
  tool: string;
  item: string;
  facts: string;
  back?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string>();
  return (
    <span className="flex items-center gap-2">
      {error && <span className="text-destructive text-xs">{error}</span>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await setNotNow(slug, tool, item, facts, back);
            setError(result.error);
          })
        }
      >
        {pending ? "One moment…" : back ? "Show it again" : "Not now"}
      </Button>
    </span>
  );
}
