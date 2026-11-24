import type { Metadata } from "next";
import Link from "next/link";
import { requirePlatformAdmin } from "@/lib/admin/platform";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin" },
  robots: { index: false, follow: false },
};

/**
 * The platform admin area: for the people who run the suite, apart from any
 * workspace role. Anyone else who is signed in gets "not found". Always
 * light, like every page outside a workspace.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requirePlatformAdmin();

  return (
    <div className="tuft-scope flex min-h-dvh flex-col" data-theme="light">
      <header className="rail-texture text-on-teal flex flex-wrap items-center justify-between gap-x-6 gap-y-1 px-4 py-3 md:px-8 print:hidden">
        <Link
          href="/admin"
          className="focus-visible:ring-ochre flex items-baseline gap-2 rounded-sm outline-none focus-visible:ring-2"
        >
          <span className="font-display text-[19px] leading-none tracking-[0.02em]">
            Maker Business Suite
          </span>
          <span className="text-on-teal-2 text-[10.5px] font-semibold tracking-[0.16em] uppercase">
            Admin
          </span>
        </Link>
        <form
          action="/auth/signout"
          method="post"
          className="text-on-teal-2 flex min-w-0 items-center gap-4 text-xs"
        >
          <span className="truncate" title={user.email}>
            {user.email}
          </span>
          <Link href="/app" className="hover:text-on-teal shrink-0 underline underline-offset-2">
            Back to the app
          </Link>
          <button
            type="submit"
            className="hover:text-on-teal shrink-0 underline underline-offset-2"
          >
            Sign out
          </button>
        </form>
      </header>
      <main className="min-w-0 flex-1 px-4 pt-6 pb-16 md:px-8 md:pt-8">
        <div className="flex w-full flex-col gap-6">{children}</div>
      </main>
    </div>
  );
}
