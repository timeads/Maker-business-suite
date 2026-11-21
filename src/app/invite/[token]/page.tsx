import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { AcceptForm } from "./accept-form";

export const metadata: Metadata = { title: "Join a workspace", robots: { index: false } };

type InvitePreview = {
  tenant_name: string;
  tenant_slug: string;
  email: string;
  role: "admin" | "member";
  status: "open" | "accepted" | "revoked" | "expired";
};

const CLOSED_COPY: Record<Exclude<InvitePreview["status"], "open">, string> = {
  accepted: "This invite has already been used.",
  revoked: "This invite was withdrawn. Ask whoever invited you for a new one.",
  expired: "This invite has expired. Ask whoever invited you for a new one.",
};

function SignOutLink({ label }: { label: string }) {
  return (
    <form action="/auth/signout" method="post">
      <button type="submit" className="text-sm underline underline-offset-4">
        {label}
      </button>
    </form>
  );
}

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await requireUser(`/invite/${token}`);

  const supabase = await createClient();
  const { data } = await supabase.rpc("get_invite", { p_token: token });
  const invite = (data as InvitePreview[] | null)?.[0];
  const wrongAccount = invite && invite.email !== user.email?.toLowerCase();

  let title = "This invite link isn't valid";
  let description = "Check that you copied the whole link, or ask for a new invite.";
  let body: React.ReactNode = (
    <Button asChild variant="outline">
      <Link href="/app">Go to your workspaces</Link>
    </Button>
  );

  if (invite && invite.status !== "open") {
    title = `Invite to ${invite.tenant_name}`;
    description = CLOSED_COPY[invite.status];
  } else if (invite && wrongAccount) {
    title = `Invite to ${invite.tenant_name}`;
    description = `This invite was sent to ${invite.email}, but you're signed in as ${user.email}.`;
    body = <SignOutLink label={`Sign out and sign back in as ${invite.email}`} />;
  } else if (invite) {
    title = `Join ${invite.tenant_name}`;
    description = `You've been invited as ${invite.role === "admin" ? "an admin" : "a member"}. You're signed in as ${user.email}.`;
    body = <AcceptForm token={token} workspaceName={invite.tenant_name} />;
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center gap-6 px-4 py-12">
      <p className="text-primary text-sm font-medium">Maker Business Suite</p>
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    </main>
  );
}
