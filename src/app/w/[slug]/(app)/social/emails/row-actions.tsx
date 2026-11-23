"use client";

import { useTransition } from "react";
import { Button } from "@/components/ui/button";
import { copyEmail, deleteEmail } from "../../../emails/actions";

export function RowActions({ slug, id, title }: { slug: string; id: string; title: string }) {
  const [pending, start] = useTransition();
  return (
    <span className="flex gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => start(() => copyEmail(slug, id))}
      >
        Copy
      </Button>
      <Button
        type="button"
        variant="danger"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (window.confirm(`Delete "${title}"? This can't be undone.`)) {
            start(() => deleteEmail(slug, id));
          }
        }}
      >
        Delete
      </Button>
    </span>
  );
}
