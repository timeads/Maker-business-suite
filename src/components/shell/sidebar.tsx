import {
  CalendarDays,
  Ellipsis,
  Home,
  Inbox,
  LineChart,
  Lock,
  Boxes,
  Megaphone,
  MessagesSquare,
  Plug,
  LifeBuoy,
  Settings,
  Sparkles,
  Truck,
} from "lucide-react";
import type { Entitlements } from "@/lib/entitlements";
import { MODULES, type ModuleKey } from "@/lib/modules";
import type { Tenant } from "@/lib/tenants";
import { NavLink, TabLink } from "./nav-link";
import type { Attention } from "@/lib/attention";
import { WorkspaceSwitcher } from "./workspace-switcher";

const MODULE_ICONS: Record<ModuleKey, typeof Home> = {
  messages: MessagesSquare,
  dashboard: LineChart,
  helpdesk: Inbox,
  bookings: CalendarDays,
  social: Megaphone,
  stock: Boxes,
  shipping: Truck,
};

/** The little number beside a tool that has something waiting. */
function Count({ n }: { n: number | undefined }) {
  if (!n) return null;
  return (
    <span className="bg-ochre text-primary-foreground ml-auto min-w-5 rounded-full px-1.5 text-center text-[11px] leading-5 font-bold tabular-nums">
      {n > 99 ? "99+" : n}
      <span className="sr-only"> waiting</span>
    </span>
  );
}

const GROUP =
  "text-on-teal-2 px-2.5 pt-5 pb-1.5 text-[10.5px] font-semibold tracking-[0.16em] uppercase";

/**
 * The teal rail. On a phone it becomes a bar along the bottom with the tools
 * you can use, and everything else behind "More".
 */
export function Sidebar({
  tenant,
  tenants,
  userEmail,
  entitlements,
  attention = {},
}: {
  /** How many things are waiting in each tool. */
  attention?: Attention;
  tenant: Tenant;
  entitlements: Entitlements;
  tenants: Tenant[];
  userEmail: string | undefined;
}) {
  const base = `/w/${tenant.slug}`;
  const usable = MODULES.filter((m) => m.available && entitlements.can(`module.${m.key}`));
  const locked = MODULES.filter((m) => !(m.available && entitlements.can(`module.${m.key}`)));

  return (
    <>
      <aside className="rail-texture sticky top-0 hidden h-dvh w-[228px] shrink-0 flex-col p-3 md:flex print:hidden">
        <WorkspaceSwitcher key={tenant.id} current={tenant} tenants={tenants} />

        <nav aria-label="Workspace" className="mt-3 flex flex-col gap-0.5 overflow-y-auto">
          <NavLink href={base} exact>
            <Home aria-hidden /> Home
          </NavLink>
          <NavLink href={`${base}/assistant`}>
            <Sparkles aria-hidden /> Assistant
          </NavLink>

          <p className={GROUP}>Tools</p>
          {usable.map((m) => {
            const Icon = MODULE_ICONS[m.key];
            return (
              <NavLink key={m.key} href={`${base}/${m.key}`}>
                <Icon aria-hidden /> {m.name}
                <Count n={attention[m.key]} />
              </NavLink>
            );
          })}
          {locked.map((m) => {
            const Icon = MODULE_ICONS[m.key];
            const soon = entitlements.can(`module.${m.key}`);
            return (
              <span
                key={m.key}
                aria-disabled="true"
                title={
                  soon
                    ? `${m.name} is on your plan and arrives soon`
                    : `${m.name} isn't on your plan`
                }
                className="text-on-teal-2/55 flex cursor-not-allowed items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm [&_svg]:size-4"
              >
                <Icon aria-hidden /> {m.name}
                {soon ? (
                  <span className="ml-auto text-[11px]">Soon</span>
                ) : (
                  <Lock className="ml-auto size-3!" aria-label="Not on your plan" />
                )}
              </span>
            );
          })}

          <p className={GROUP}>Workspace</p>
          <NavLink href={`${base}/connections`}>
            <Plug aria-hidden /> Connections
          </NavLink>
          <NavLink href={`${base}/settings`}>
            <Settings aria-hidden /> Settings
          </NavLink>
          <NavLink href="/help">
            <LifeBuoy aria-hidden /> Help
          </NavLink>
        </nav>

        <form
          action="/auth/signout"
          method="post"
          className="text-on-teal-2 mt-auto flex items-center justify-between gap-2 px-2.5 pt-3 text-xs"
        >
          <span className="truncate" title={userEmail}>
            {userEmail}
          </span>
          <button
            type="submit"
            className="hover:text-on-teal focus-visible:ring-ochre shrink-0 rounded-sm underline underline-offset-2 outline-none focus-visible:ring-2"
          >
            Sign out
          </button>
        </form>
      </aside>

      <nav
        aria-label="Workspace"
        className="bg-teal fixed inset-x-0 bottom-0 z-30 flex items-stretch pb-[env(safe-area-inset-bottom)] md:hidden print:hidden"
      >
        <TabLink href={base} exact>
          <Home aria-hidden /> Home
        </TabLink>
        {usable.slice(0, 3).map((m) => {
          const Icon = MODULE_ICONS[m.key];
          return (
            <TabLink key={m.key} href={`${base}/${m.key}`}>
              <span className="relative">
                <Icon aria-hidden />
                {attention[m.key] ? (
                  <span className="bg-ochre text-primary-foreground absolute -top-1.5 -right-2.5 min-w-4 rounded-full px-1 text-center text-[10px] leading-4 font-bold">
                    {attention[m.key]! > 99 ? "99+" : attention[m.key]}
                    <span className="sr-only"> waiting</span>
                  </span>
                ) : null}
              </span>
              <span className="max-w-full truncate">{m.name}</span>
            </TabLink>
          );
        })}
        <details className="group relative flex flex-1">
          <summary className="text-on-teal-2 flex flex-1 cursor-pointer list-none flex-col items-center gap-1 px-1 pt-2 pb-1.5 text-[10.5px] font-semibold group-open:text-white [&::-webkit-details-marker]:hidden">
            <Ellipsis className="size-5" aria-hidden /> More
          </summary>
          <div className="border-border bg-card text-foreground absolute right-2 bottom-full mb-2 flex w-60 flex-col gap-0.5 rounded-lg border p-1.5 shadow-lg">
            <p className="truncate px-2 py-1.5 text-sm font-bold">{tenant.name}</p>
            {[
              ...usable.slice(3).map((m) => ({ href: `${base}/${m.key}`, label: m.name })),
              { href: `${base}/assistant`, label: "Assistant" },
              { href: `${base}/connections`, label: "Connections" },
              { href: `${base}/settings`, label: "Settings" },
              { href: "/help", label: "Help" },
              { href: "/app", label: "Switch workspace" },
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
