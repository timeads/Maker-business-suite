"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Boxes,
  CalendarDays,
  Check,
  Ellipsis,
  Home,
  Inbox,
  LifeBuoy,
  LineChart,
  Lock,
  Megaphone,
  MessagesSquare,
  Plug,
  Plus,
  Settings,
  Sparkles,
  Truck,
  Wrench,
} from "lucide-react";
import type { NavTool, ToolKey } from "@/lib/nav/model";
import type { Tenant } from "@/lib/tenants";
import { cn } from "@/lib/utils";
import { useShell } from "./nav-context";

const ICONS: Record<ToolKey, typeof Home> = {
  home: Home,
  assistant: Sparkles,
  messages: MessagesSquare,
  dashboard: LineChart,
  helpdesk: Inbox,
  bookings: CalendarDays,
  social: Megaphone,
  stock: Boxes,
  shipping: Truck,
  connections: Plug,
  settings: Settings,
};

const SPOT =
  "focus-visible:ring-on-teal relative flex size-10 shrink-0 items-center justify-center rounded-md outline-none transition-colors duration-150 focus-visible:ring-2 [&_svg]:size-5";
const POPOVER =
  "border-border bg-card text-foreground absolute left-full z-40 ml-2 w-60 rounded-lg border p-1 shadow-lg";
const POP_ROW = "hover:bg-hover flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm";

/** Up to two letters for the workspace's mark: "Wild Thread Studio" → "WT". */
function markOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}

const shown = (n: number) => (n > 99 ? "99+" : String(n));

/**
 * The hub rail: a slim strip of the workspace's tools that is the same on
 * every page. Each icon carries its name for screen readers and shows it
 * beside the rail on hover or focus. On a phone the rail becomes a bar along
 * the bottom with the first tools, and everything else behind "More".
 */
export function HubRail({
  tenant,
  tenants,
  userEmail,
  platformAdmin = false,
}: {
  tenant: Tenant;
  tenants: Tenant[];
  userEmail: string | undefined;
  /** Shows the "Admin" link; true only for the people who run the suite. */
  platformAdmin?: boolean;
}) {
  const shell = useShell();
  const [tip, setTip] = useState<{ label: string; top: number } | null>(null);
  useEffect(() => {
    if (!tip) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTip(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tip]);
  if (!shell) return null;

  const base = `/w/${tenant.slug}`;
  const { tools } = shell;
  const current = shell.tool?.key;
  const hrefOf = (tool: NavTool) => (tool.to ? `${base}/${tool.to}` : base);
  const tips = (label: string) => ({
    onPointerEnter: (event: React.PointerEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      setTip({ label, top: box.top + box.height / 2 });
    },
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      const box = event.currentTarget.getBoundingClientRect();
      setTip({ label, top: box.top + box.height / 2 });
    },
    onPointerLeave: () => setTip(null),
    onBlur: () => setTip(null),
  });

  const spot = (tool: NavTool) => {
    const Icon = ICONS[tool.key];
    if (tool.state !== "open") {
      const why =
        tool.state === "soon"
          ? `${tool.name} is on your plan and arrives soon`
          : `${tool.name} isn't on your plan`;
      return (
        <li key={tool.key}>
          <span
            role="link"
            aria-disabled="true"
            aria-label={why}
            tabIndex={0}
            className={cn(SPOT, "text-on-teal-2/45 cursor-not-allowed")}
            {...tips(why)}
          >
            <Icon aria-hidden />
            {tool.state === "locked" && (
              <Lock aria-hidden className="absolute right-1 bottom-1 size-2.5!" />
            )}
          </span>
        </li>
      );
    }
    const on = tool.key === current;
    return (
      <li key={tool.key}>
        <Link
          href={hrefOf(tool)}
          aria-label={tool.count ? `${tool.name}, ${shown(tool.count)} waiting` : tool.name}
          aria-current={on ? "page" : undefined}
          className={cn(
            SPOT,
            on
              ? "bg-ochre text-primary-foreground"
              : "text-on-teal-2 hover:bg-teal-2 hover:text-on-teal",
          )}
          {...tips(tool.name)}
        >
          <Icon aria-hidden />
          {tool.count ? (
            <span
              aria-hidden
              className={cn(
                "ring-teal absolute -top-1 -right-1 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold ring-2",
                on ? "bg-on-teal text-teal" : "bg-ochre text-primary-foreground",
              )}
            >
              {shown(tool.count)}
            </span>
          ) : null}
        </Link>
      </li>
    );
  };
  const stretch = (place: NavTool["place"]) => tools.filter((tool) => tool.place === place);
  const usable = tools.filter((tool) => tool.place === "tools" && tool.state === "open");
  const home = tools.find((tool) => tool.key === "home");
  const RULE = "bg-teal-3 mx-auto my-1.5 h-px w-6";

  return (
    <>
      <aside className="rail-texture sticky top-0 z-30 hidden h-dvh w-14 shrink-0 flex-col items-center py-2.5 md:flex print:hidden">
        <details className="group relative">
          <summary
            aria-label={`${tenant.name}: switch workspace`}
            className="bg-on-teal text-teal font-display focus-visible:ring-ochre flex size-9 cursor-pointer list-none items-center justify-center rounded-md text-[15px] leading-none tracking-[0.02em] outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
            {...tips(tenant.name)}
          >
            {markOf(tenant.name)}
          </summary>
          <div className={cn(POPOVER, "top-0")}>
            <p className="truncate px-2 pt-1.5 pb-1 text-sm font-bold">{tenant.name}</p>
            <ul>
              {tenants.map((t) => (
                <li key={t.id}>
                  <Link href={`/w/${t.slug}`} className={cn(POP_ROW, "justify-between")}>
                    <span className="truncate">{t.name}</span>
                    {t.id === tenant.id && (
                      <Check className="size-4 shrink-0" aria-label="Current" />
                    )}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="border-border mt-1 border-t pt-1">
              <Link href="/onboarding" className={cn(POP_ROW, "text-muted-foreground")}>
                <Plus className="size-4" aria-hidden />
                New workspace
              </Link>
              {platformAdmin && (
                <Link href="/admin" className={cn(POP_ROW, "text-muted-foreground")}>
                  <Wrench className="size-4" aria-hidden />
                  Admin
                </Link>
              )}
            </div>
          </div>
        </details>

        <nav
          aria-label="Tools"
          className="mt-2.5 flex min-h-0 w-full flex-1 [scrollbar-width:none] flex-col items-center overflow-y-auto py-1"
        >
          <ul className="flex flex-col items-center gap-1">{stretch("top").map(spot)}</ul>
          <div aria-hidden className={RULE} />
          <ul className="flex flex-col items-center gap-1">{stretch("tools").map(spot)}</ul>
          <div aria-hidden className={RULE} />
          <ul className="flex flex-col items-center gap-1">{stretch("workspace").map(spot)}</ul>
        </nav>

        <div className="mt-1 flex flex-col items-center gap-1 pt-1">
          <Link
            href="/help"
            aria-label="Help"
            className={cn(SPOT, "text-on-teal-2 hover:bg-teal-2 hover:text-on-teal")}
            {...tips("Help")}
          >
            <LifeBuoy aria-hidden />
          </Link>
          <details className="group relative">
            <summary
              aria-label={`You: ${userEmail ?? "signed in"}`}
              className="bg-teal-3 text-on-teal focus-visible:ring-on-teal flex size-8 cursor-pointer list-none items-center justify-center rounded-full text-xs font-bold uppercase outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden"
              {...tips("You")}
            >
              {(userEmail ?? "?").slice(0, 1)}
            </summary>
            <div className={cn(POPOVER, "bottom-0")}>
              <p className="text-muted-foreground truncate px-2 py-1.5 text-xs" title={userEmail}>
                {userEmail}
              </p>
              <form action="/auth/signout" method="post">
                <button type="submit" className={cn(POP_ROW, "w-full text-left")}>
                  Sign out
                </button>
              </form>
            </div>
          </details>
        </div>

        {tip && (
          <span
            aria-hidden
            style={{ top: tip.top }}
            className="bg-foreground text-background pointer-events-none fixed left-[62px] z-50 max-w-56 -translate-y-1/2 rounded-sm px-2 py-1 text-xs font-semibold shadow-lg"
          >
            {tip.label}
          </span>
        )}
      </aside>

      <nav
        aria-label="Tools"
        className="bg-teal fixed inset-x-0 bottom-0 z-30 flex items-stretch pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
      >
        {[...(home ? [home] : []), ...usable.slice(0, 3)].map((tool) => {
          const Icon = ICONS[tool.key];
          const on = tool.key === current;
          return (
            <Link
              key={tool.key}
              href={hrefOf(tool)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-1 flex-col items-center gap-1 px-1 pt-2 pb-1.5 text-[10.5px] font-semibold outline-none [&_svg]:size-5",
                on ? "text-white" : "text-on-teal-2",
              )}
            >
              <span className="relative">
                <Icon aria-hidden />
                {tool.count ? (
                  <span className="bg-ochre text-primary-foreground absolute -top-1.5 -right-2.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold">
                    {shown(tool.count)}
                    <span className="sr-only"> waiting</span>
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate">{tool.name}</span>
              {on && <span aria-hidden className="bg-ochre -mt-0.5 h-0.5 w-5 rounded-full" />}
            </Link>
          );
        })}
        <details className="group relative flex flex-1">
          <summary className="text-on-teal-2 flex flex-1 cursor-pointer list-none flex-col items-center gap-1 px-1 pt-2 pb-1.5 text-[10.5px] font-semibold group-open:text-white [&::-webkit-details-marker]:hidden">
            <Ellipsis className="size-5" aria-hidden /> More
          </summary>
          <div className="border-border bg-card text-foreground absolute right-2 bottom-full mb-2 flex max-h-[70dvh] w-60 flex-col gap-0.5 overflow-y-auto rounded-lg border p-1.5 shadow-lg">
            <p className="truncate px-2 py-1.5 text-sm font-bold">{tenant.name}</p>
            {[
              ...usable.slice(3).map((tool) => ({ href: hrefOf(tool), label: tool.name })),
              { href: `${base}/assistant`, label: "Assistant" },
              { href: `${base}/connections`, label: "Connections" },
              { href: `${base}/settings`, label: "Settings" },
              { href: "/help", label: "Help" },
              { href: "/app", label: "Switch workspace" },
              ...(platformAdmin ? [{ href: "/admin", label: "Admin" }] : []),
            ].map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="hover:bg-hover rounded-sm px-2 py-2 text-sm"
              >
                {item.label}
              </a>
            ))}
            <form action="/auth/signout" method="post" className="border-border mt-1 border-t pt-1">
              <button
                type="submit"
                className="hover:bg-hover w-full rounded-sm px-2 py-2 text-left text-sm"
              >
                Sign out
              </button>
            </form>
          </div>
        </details>
      </nav>
    </>
  );
}
