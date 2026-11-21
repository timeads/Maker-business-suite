import Link from "next/link";
import { Check, ChevronsUpDown, Plus } from "lucide-react";
import type { Tenant } from "@/lib/tenants";

export function WorkspaceSwitcher({ current, tenants }: { current: Tenant; tenants: Tenant[] }) {
  return (
    <details className="group relative">
      <summary className="border-border bg-card focus-visible:ring-ring flex cursor-pointer list-none items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 [&::-webkit-details-marker]:hidden">
        <span className="truncate">{current.name}</span>
        <ChevronsUpDown className="text-muted-foreground size-4 shrink-0" aria-hidden />
        <span className="sr-only">Switch workspace</span>
      </summary>
      <div className="border-border bg-card absolute top-full right-0 left-0 z-20 mt-1 rounded-md border p-1 shadow-lg">
        <ul>
          {tenants.map((t) => (
            <li key={t.id}>
              <Link
                href={`/w/${t.slug}`}
                className="hover:bg-muted flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm"
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
            className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2 rounded-sm px-2 py-1.5 text-sm"
          >
            <Plus className="size-4" aria-hidden />
            New workspace
          </Link>
        </div>
      </div>
    </details>
  );
}
