import { CalendarDays, Home, Inbox, LineChart, Lock, Megaphone, Settings } from "lucide-react";
import { can } from "@/lib/entitlements";
import { MODULES, type ModuleKey } from "@/lib/modules";
import type { Tenant } from "@/lib/tenants";
import { NavLink } from "./nav-link";
import { WorkspaceSwitcher } from "./workspace-switcher";

const MODULE_ICONS: Record<ModuleKey, typeof Home> = {
  dashboard: LineChart,
  helpdesk: Inbox,
  bookings: CalendarDays,
  social: Megaphone,
};

export function Sidebar({
  tenant,
  tenants,
  userEmail,
}: {
  tenant: Tenant;
  tenants: Tenant[];
  userEmail: string | undefined;
}) {
  const base = `/w/${tenant.slug}`;
  return (
    <aside className="border-border bg-sidebar flex shrink-0 flex-col gap-4 border-b p-3 md:min-h-dvh md:w-64 md:border-r md:border-b-0">
      <WorkspaceSwitcher key={tenant.id} current={tenant} tenants={tenants} />

      <nav aria-label="Workspace" className="flex flex-col gap-1">
        <NavLink href={base} exact>
          <Home aria-hidden /> Home
        </NavLink>

        <p className="text-muted-foreground px-3 pt-4 pb-1 text-xs font-medium tracking-wide uppercase">
          Modules
        </p>
        {MODULES.map((m) => {
          const Icon = MODULE_ICONS[m.key];
          if (can(tenant, `module.${m.key}`)) {
            return (
              <NavLink key={m.key} href={`${base}/${m.key}`}>
                <Icon aria-hidden /> {m.name}
              </NavLink>
            );
          }
          return (
            <span
              key={m.key}
              aria-disabled="true"
              title={`${m.name} isn't switched on yet`}
              className="text-muted-foreground/60 flex cursor-not-allowed items-center gap-2 rounded-md px-3 py-2 text-sm [&_svg]:size-4"
            >
              <Icon aria-hidden /> {m.name}
              <Lock className="ml-auto size-3!" aria-label="Not switched on yet" />
            </span>
          );
        })}
      </nav>

      <div className="flex flex-col gap-1 md:mt-auto">
        <NavLink href={`${base}/settings`}>
          <Settings aria-hidden /> Settings
        </NavLink>
        <form
          action="/auth/signout"
          method="post"
          className="text-muted-foreground flex items-center justify-between gap-2 px-3 py-2 text-xs"
        >
          <span className="truncate" title={userEmail}>
            {userEmail}
          </span>
          <button
            type="submit"
            className="hover:text-foreground shrink-0 underline underline-offset-4"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
