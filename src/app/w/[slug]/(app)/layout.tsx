import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

/**
 * The padded, centred column most workspace pages sit in. Tools that need
 * the whole window (Messages) live beside this group instead of inside it.
 */
export default async function PaddedLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: pendingInvites } = await supabase.rpc("my_pending_invites");
  const inviteCount = Array.isArray(pendingInvites) ? pendingInvites.length : 0;

  return (
    <main className="min-w-0 flex-1 px-4 pt-6 pb-24 md:px-8 md:pt-8 md:pb-12">
      <div className="mx-auto flex max-w-5xl flex-col gap-6">
        {inviteCount > 0 && (
          <p role="status" className="border-border bg-muted rounded-md border px-3 py-2 text-sm">
            You&apos;ve been invited to{" "}
            {inviteCount === 1 ? "another workspace" : `${inviteCount} other workspaces`}.{" "}
            <Link href="/app" className="font-medium underline underline-offset-4">
              View invite{inviteCount === 1 ? "" : "s"}
            </Link>
          </p>
        )}
        {children}
      </div>
    </main>
  );
}
