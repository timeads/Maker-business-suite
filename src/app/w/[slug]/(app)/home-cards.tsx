"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  Boxes,
  CalendarDays,
  ChevronRight,
  Inbox,
  LineChart,
  Megaphone,
  MessagesSquare,
  SlidersHorizontal,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { ModuleKey } from "@/lib/modules";
import { cn } from "@/lib/utils";

export type HomeCard = {
  key: ModuleKey;
  name: string;
  /** What's waiting, in a few words. */
  headline: string;
  detail?: string;
  /** Something here wants doing today. */
  waiting: boolean;
  href: string;
};

const ICONS: Record<ModuleKey, typeof Inbox> = {
  messages: MessagesSquare,
  dashboard: LineChart,
  helpdesk: Inbox,
  bookings: CalendarDays,
  social: Megaphone,
  stock: Boxes,
  shipping: Truck,
};

/**
 * One card per tool, the ones that need someone first. Each person chooses
 * which cards they see; the choice is kept in their own browser, so it is a
 * convenience and nothing breaks without it.
 */
export function HomeCards({ slug, cards }: { slug: string; cards: HomeCard[] }) {
  const storageKey = `home-hidden:${slug}`;
  const [hidden, setHidden] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
      // Read once after the page is shown, so server and browser draw the same first.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a stored preference, read after mount
      if (Array.isArray(saved)) setHidden(saved.filter((k) => typeof k === "string"));
    } catch {
      // No storage (private window, blocked): every card shows.
    }
  }, [storageKey]);
  const toggle = (key: string) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key];
    setHidden(next);
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // Kept for this visit only.
    }
  };
  const shown = cards.filter((card) => !hidden.includes(card.key));

  return (
    <section aria-label="Your tools" className="flex flex-col gap-3">
      <details className="group relative self-end">
        <summary className="border-input bg-card hover:bg-hover flex cursor-pointer list-none items-center gap-2 rounded-sm border px-3 py-1.5 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <SlidersHorizontal className="size-4" aria-hidden /> Choose cards
          {hidden.length > 0 && (
            <span className="text-muted-foreground font-normal">({hidden.length} hidden)</span>
          )}
        </summary>
        <fieldset className="border-border bg-card absolute right-0 z-10 mt-1 flex w-56 flex-col gap-1 rounded-lg border p-2 shadow-lg">
          <legend className="sr-only">Cards to show on Home</legend>
          {cards.map((card) => (
            <label
              key={card.key}
              className="hover:bg-hover flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
            >
              <input
                type="checkbox"
                checked={!hidden.includes(card.key)}
                onChange={() => toggle(card.key)}
              />
              {card.name}
            </label>
          ))}
        </fieldset>
      </details>

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Every card is hidden. Use &ldquo;Choose cards&rdquo; to bring some back.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {shown.map((card) => {
            const Icon = ICONS[card.key];
            return (
              <li key={card.key}>
                <Link
                  href={card.href}
                  className="bg-card border-border hover:bg-hover focus-visible:ring-ring flex h-full flex-col gap-3 rounded-lg border p-4 transition-colors duration-150 outline-none focus-visible:ring-2"
                >
                  <span className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-md",
                        card.waiting
                          ? "bg-ochre-soft text-ochre-text"
                          : "bg-sunken text-muted-foreground",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="text-sm font-semibold">{card.name}</span>
                    {card.waiting && (
                      <span className="ml-auto">
                        <Badge tone="waiting">Needs you</Badge>
                      </span>
                    )}
                  </span>
                  <span className="flex flex-1 flex-col gap-0.5">
                    <span className={cn("text-base", card.waiting && "font-semibold")}>
                      {card.headline}
                    </span>
                    {card.detail && (
                      <span className="text-muted-foreground text-sm">{card.detail}</span>
                    )}
                  </span>
                  <span className="text-ochre-text flex items-center gap-1 text-sm font-medium">
                    Open {card.name} <ChevronRight className="size-4" aria-hidden />
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
