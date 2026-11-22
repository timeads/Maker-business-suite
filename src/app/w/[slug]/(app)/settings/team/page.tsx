import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext, type Role } from "@/lib/tenants";
import { revokeInvite } from "../actions";
import { InviteForm } from "./invite-form";

export const metadata: Metadata = { title: "Team" };

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

type Member = { user_id: string; email: string; role: Role };
type Invite = { id: string; email: string; role: Role; expires_at: string };

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-xs">
      {ROLE_LABELS[role]}
    </span>
  );
}

export default async function TeamPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/team`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const { tenant, role } = ctx;
  const manager = canManage(role);

  const supabase = await createClient();
  const { data: roster } = await supabase.rpc("list_members", { p_tenant_id: tenant.id });
  const members = (roster as Member[] | null) ?? [];

  let invites: Invite[] = [];
  if (manager) {
    const { data } = await supabase
      .from("invites")
      .select("id, email, role, expires_at")
      .eq("tenant_id", tenant.id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    invites = (data as Invite[] | null) ?? [];
  }

  const expiryFormat = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: tenant.timezone,
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Team</CardTitle>
          <CardDescription>Everyone who can sign in to {tenant.name}.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-border divide-y">
            {members.map((m) => (
              <li key={m.user_id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <span className="truncate">
                  {m.email}
                  {m.user_id === user.id && <span className="text-muted-foreground"> (you)</span>}
                </span>
                <RoleBadge role={m.role} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>
              Admins can change settings and invite people. Members can use the tools.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <InviteForm slug={tenant.slug} />

            {invites.length > 0 && (
              <div className="flex flex-col gap-2">
                <h3 className="text-sm font-medium">Waiting to join</h3>
                <ul className="divide-border divide-y">
                  {invites.map((invite) => (
                    <li
                      key={invite.id}
                      className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm"
                    >
                      <span className="min-w-0">
                        <span className="block truncate">{invite.email}</span>
                        <span className="text-muted-foreground text-xs">
                          Link works until {expiryFormat.format(new Date(invite.expires_at))}
                        </span>
                      </span>
                      <span className="flex items-center gap-2">
                        <RoleBadge role={invite.role} />
                        <form action={revokeInvite.bind(null, tenant.slug)}>
                          <input type="hidden" name="inviteId" value={invite.id} />
                          <Button type="submit" variant="ghost" size="sm">
                            Withdraw
                          </Button>
                        </form>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}
