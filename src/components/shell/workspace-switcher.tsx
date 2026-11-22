import Link from "next/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import type { Tenant } from "@/lib/tenants";

/** The business's name set as the wordmark, doubling as the workspace menu. */
export function WorkspaceSwitcher({ current, tenants }: { current: Tenant; tenants: Tenant[] }) {
  return (
    <details className="group relative">
      <summary className="text-on-teal hover:bg-teal-2 focus-visible:ring-ochre flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm px-2.5 py-2 outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
        <span className="font-display line-clamp-2 text-[19px] leading-[1.1] tracking-[0.02em] text-balance">
          {current.name}
        </span>
        <ChevronsUpDown className="text-on-teal-2 size-4 shrink-0" aria-hidden />
        <span className="sr-only">Switch workspace</span>
      </summary>
      <div className="border-border bg-card text-foreground absolute top-full right-0 left-0 z-30 mt-1 rounded-lg border p-1 shadow-lg">
        <ul>
          {tenants.map((t) => (
            <li key={t.id}>
              <Link
                href={`/w/${t.slug}`}
                className="hover:bg-hover flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm"
              >
                <span className="truncate">{t.name}</span>
                {t.id === current.id && <Check className="size-4 shrink-0" aria-label="Current" />}
              </Link>
            </li>
          ))}
        </ul>
        <div className="border-border mt-1 border-t pt-1">
          <Link
            href="/onboarding"
            className="text-muted-foreground hover:bg-hover hover:text-foreground flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
          >
            <Plus className="size-4" aria-hidden />
            New workspace
          </Link>
        </div>
      </div>
    </details>
  );
}
