"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function useIsActive(href: string, exact = false): boolean {
  const pathname = usePathname();
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** A row in the teal rail. */
export function NavLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const active = useIsActive(href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "focus-visible:ring-ochre flex items-center gap-2.5 rounded-sm px-2.5 py-2 text-sm transition-colors duration-150 outline-none focus-visible:ring-2 [&_svg]:size-4 [&_svg]:shrink-0",
        active
          ? "bg-teal-3 font-semibold text-white"
          : "text-on-teal-2 hover:bg-teal-2 hover:text-on-teal",
      )}
    >
      {children}
    </Link>
  );
}

/** A tab in the phone's bottom bar. */
export function TabLink({
  href,
  exact = false,
  children,
}: {
  href: string;
  exact?: boolean;
  children: React.ReactNode;
}) {
  const active = useIsActive(href, exact);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center gap-1 px-1 pt-2 pb-1.5 text-[10.5px] font-semibold outline-none [&_svg]:size-5",
        active ? "text-white" : "text-on-teal-2",
      )}
    >
      {children}
    </Link>
  );
}
