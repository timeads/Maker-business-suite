import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listMyTenants } from "@/lib/tenants";
import { JoinForm } from "./join-form";

export const metadata: Metadata = { title: "Your workspaces" };

type PendingInvite = {
  invite_id: string;
  tenant_name: string;
  role: "admin" | "member";
};

/**
 * Front door after sign-in. Normally a redirect to your first workspace (or
 * to onboarding if you have none). If someone has invited you to a workspace,
 * you see that first.
 */
export default async function AppIndexPage() {
  const user = await requireUser("/app");
  const supabase = await createClient();
  const [tenants, pending] = await Promise.all([
    listMyTenants(),
    supabase.rpc("my_pending_invites"),
  ]);
  const invites = (pending.data as PendingInvite[] | null) ?? [];

  if (invites.length === 0) {
    redirect(tenants.length > 0 ? `/w/${tenants[0].slug}` : "/onboarding");
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-6 px-4 py-12">
      <p className="text-primary text-sm font-medium">Maker Business Suite</p>
      {invites.map((invite) => (
        <Card key={invite.invite_id}>
          <CardHeader>
            <CardTitle>You&apos;re invited to {invite.tenant_name}</CardTitle>
            <CardDescription>
              You&apos;ll join as {invite.role === "admin" ? "an admin" : "a member"}, signed in as{" "}
              {user.email}.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <JoinForm inviteId={invite.invite_id} workspaceName={invite.tenant_name} />
          </CardContent>
        </Card>
      ))}

      <div className="flex flex-col gap-2">
        {tenants.length > 0 ? (
          <>
            <p className="text-muted-foreground text-sm">
              Or carry on to a workspace you&apos;re in:
            </p>
            <ul className="flex flex-wrap gap-2">
              {tenants.map((tenant) => (
                <li key={tenant.id}>
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/w/${tenant.slug}`}>{tenant.name}</Link>
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <Button asChild variant="ghost" className="w-fit">
            <Link href="/onboarding">Set up my own workspace instead</Link>
          </Button>
        )}
      </div>
    </main>
  );
}
