import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { canManage, getTenantContext } from "@/lib/tenants";
import { loadChat } from "./actions";
import { ChatApp } from "./chat-app";

export const metadata: Metadata = { title: "Messages" };

export default async function MessagesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/messages`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const entitlements = await getEntitlements(ctx.tenant.id);

  if (!entitlements.can("module.messages")) {
    return (
      <main className="flex flex-1 items-center justify-center p-6 pb-24">
        <div className="border-border bg-card flex max-w-md flex-col gap-3 rounded-xl border p-6">
          <h1 className="text-2xl font-bold tracking-[-0.015em]">Messages</h1>
          <p className="text-muted-foreground font-read text-sm">
            Team chat for your workspace, with heads-ups from your other tools.{" "}
            {entitlements.plan
              ? "It isn't part of your current plan."
              : "Pick a plan to switch it on — the first 14 days are free."}
          </p>
          {canManage(ctx.role) ? (
            <Button asChild className="w-fit">
              <Link href={`/w/${ctx.tenant.slug}/settings/billing`}>See plans</Link>
            </Button>
          ) : (
            <p className="text-muted-foreground text-sm">Ask a workspace owner to switch it on.</p>
          )}
        </div>
      </main>
    );
  }

  const initial = await loadChat(slug);
  return (
    <ChatApp
      slug={ctx.tenant.slug}
      tenantId={ctx.tenant.id}
      timeZone={ctx.tenant.timezone}
      myId={user.id}
      canWrite={entitlements.canWrite}
      initialConversations={initial.ok ? initial.conversations : []}
      initialPeople={initial.ok ? initial.people : []}
      loadError={initial.ok ? null : initial.error}
      nowIso={new Date().toISOString()}
    />
  );
}
