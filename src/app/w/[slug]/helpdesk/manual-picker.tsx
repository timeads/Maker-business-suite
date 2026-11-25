"use client";

import { useEffect, useRef, useState } from "react";
import { findInManual, type ManualHit } from "../(app)/helpdesk/manual/actions";

const field =
  "border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 h-8 w-full rounded-sm border px-2 text-sm outline-none focus-visible:ring-2";

/**
 * The reply box's way into the manual: search published topics and articles,
 * and put one (or one of its sections) into the reply as plain words to
 * edit. It only fills the box; nothing is sent from here.
 */
export function ManualPicker({
  slug,
  name,
  onPick,
}: {
  slug: string;
  name: string;
  onPick: (text: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ManualHit[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const latest = useRef(0);

  useEffect(() => {
    const mine = (latest.current += 1);
    const timer = setTimeout(
      () => {
        findInManual(slug, query)
          .then((found) => {
            if (latest.current === mine) setHits(found);
          })
          .catch(() => {
            if (latest.current === mine) setHits([]);
          });
      },
      query ? 250 : 0,
    );
    return () => clearTimeout(timer);
  }, [slug, query]);

  return (
    <>
      <input
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Search the ${name.toLowerCase()}`}
        aria-label={`Search the ${name.toLowerCase()}`}
        className={field}
      />
      <ul className="mt-1 max-h-72 overflow-y-auto">
        {hits === null && <li className="text-muted-foreground px-2 py-2 text-xs">Looking…</li>}
        {hits?.length === 0 && (
          <li className="text-muted-foreground px-2 py-2 text-xs">
            {query
              ? "Nothing published matches that."
              : "Nothing published yet. Topics show up here once they are published; articles as soon as they are written."}
          </li>
        )}
        {hits?.map((hit) => (
          <li key={`${hit.kind}:${hit.id}`} className="border-border border-b last:border-b-0">
            <button
              type="button"
              onClick={() => setOpen(open === hit.id ? null : hit.id)}
              aria-expanded={open === hit.id}
              className="hover:bg-hover w-full rounded-sm px-2 py-1.5 text-left"
            >
              <span className="block text-sm font-semibold">{hit.title}</span>
              <span className="text-muted-foreground block text-xs">
                {[hit.kind === "article" ? "Article" : null, ...hit.labels]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </button>
            {open === hit.id && (
              <div className="flex flex-col gap-1 px-2 pb-2">
                <p className="text-muted-foreground font-read line-clamp-4 text-xs whitespace-pre-wrap">
                  {hit.text}
                </p>
                <div className="flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => onPick(hit.text)}
                    className="bg-teal-soft text-teal-soft-ink rounded-full px-2.5 py-0.5 text-xs font-semibold"
                  >
                    Put all of it in the reply
                  </button>
                  {hit.sections.map((section) => (
                    <button
                      key={section.heading}
                      type="button"
                      onClick={() => onPick(section.text)}
                      className="border-border hover:bg-hover rounded-full border px-2.5 py-0.5 text-xs"
                    >
                      Only “{section.heading}”
                    </button>
                  ))}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
