"use client";

import Link from "next/link";
import { useState } from "react";
import { Input } from "@/components/ui/input";

type Row = { slug: string; group: string; title: string; summary: string; text: string };

export function HelpIndex({
  groups,
  topics,
}: {
  groups: { key: string; name: string }[];
  topics: Row[];
}) {
  const [query, setQuery] = useState("");
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const found = words.length
    ? topics.filter((topic) => words.every((word) => topic.text.includes(word)))
    : topics;

  return (
    <div className="flex flex-col gap-8">
      <div>
        <label htmlFor="help-search" className="sr-only">
          Search the help pages
        </label>
        <Input
          id="help-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search, for example “postage label” or “reorder”"
          className="h-11 text-base"
        />
        <p className="text-muted-foreground mt-2 text-sm" aria-live="polite">
          {words.length
            ? found.length === 0
              ? "Nothing matches that. Try fewer or different words."
              : `${found.length} ${found.length === 1 ? "topic" : "topics"}`
            : null}
        </p>
      </div>

      {groups.map((group) => {
        const rows = found.filter((topic) => topic.group === group.key);
        if (rows.length === 0) return null;
        return (
          <section key={group.key} aria-labelledby={`help-${group.key}`}>
            <h2 id={`help-${group.key}`} className="text-lg font-semibold">
              {group.name}
            </h2>
            <ul className="bg-card border-border divide-border mt-3 divide-y rounded-xl border">
              {rows.map((topic) => (
                <li key={topic.slug}>
                  <Link
                    href={`/help/${topic.slug}`}
                    className="hover:bg-hover flex flex-col gap-0.5 px-4 py-3 first:rounded-t-xl last:rounded-b-xl"
                  >
                    <span className="font-medium">{topic.title}</span>
                    <span className="text-muted-foreground text-sm">{topic.summary}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
