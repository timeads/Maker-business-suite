import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { getEntitlements } from "@/lib/entitlements";
import { MODULES } from "@/lib/modules";
import { createClient } from "@/lib/supabase/server";
import { MEMBER_TOOLS } from "@/lib/team/tools";
import { canManage, getTenantContext, type Role } from "@/lib/tenants";
import { revokeInvite } from "../actions";
import { InviteForm } from "./invite-form";
import { MemberToolsForm, ToolsSwitchForm, type ToolChoice } from "./tool-forms";

export const metadata: Metadata = { title: "Team" };

const ROLE_LABELS: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

type Member = { user_id: string; email: string; role: Role };
type Invite = {
  id: string;
  email: string;
  role: Role;
  expires_at: string;
  tools?: string[] | null;
};

const toolName = (key: string) => MODULES.find((m) => m.key === key)?.name ?? key;

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
  const entitlements = await getEntitlements(tenant.id);
  const perPerson = entitlements.toolsPerPerson;
  // Only the tools the plan includes can be ticked; Money never can.
  const choices: ToolChoice[] = MEMBER_TOOLS.filter((key) =>
    entitlements.onPlan(`module.${key}`),
  ).map((key) => ({ key, name: toolName(key) }));
  const { data: roster } = await supabase.rpc("list_members", { p_tenant_id: tenant.id });
  const members = (roster as Member[] | null) ?? [];
  // Managers read everyone's list; nothing to read while the switch is off.
  const { data: lists } =
    manager && perPerson
      ? await supabase.from("member_tools").select("user_id, tools").eq("tenant_id", tenant.id)
      : { data: null };
  const toolsOf = new Map(
    ((lists ?? []) as { user_id: string; tools: string[] }[]).map((row) => [
      row.user_id,
      row.tools,
    ]),
  );

  let invites: Invite[] = [];
  if (manager) {
    const { data } = await supabase
      .from("invites")
      .select(perPerson ? "id, email, role, expires_at, tools" : "id, email, role, expires_at")
      .eq("tenant_id", tenant.id)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false });
    invites = (data as unknown as Invite[] | null) ?? [];
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
              <li key={m.user_id} className="flex flex-col gap-2 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate">
                    {m.email}
                    {m.user_id === user.id && <span className="text-muted-foreground"> (you)</span>}
                  </span>
                  <RoleBadge role={m.role} />
                </div>
                {perPerson &&
                  manager &&
                  (m.role === "member" ? (
                    <MemberToolsForm
                      slug={tenant.slug}
                      userId={m.user_id}
                      email={m.email}
                      tools={choices}
                      ticked={toolsOf.get(m.user_id) ?? []}
                    />
                  ) : (
                    <p className="text-muted-foreground text-xs">Every tool, Money included.</p>
                  ))}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Choose which tools each person can open</CardTitle>
            <CardDescription>
              {perPerson
                ? "On. Each member opens only the tools ticked for them above, plus Home and Messages. Owners and admins open everything."
                : "Off. Every member can open every tool, as they do today."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            {perPerson ? (
              <p className="text-muted-foreground">
                Members can&apos;t open Money, and costs and margins are kept from them: what an
                item or a label costs you, and what you make on it. Selling prices and quantities
                stay. Turning this off lets every member open every tool again, and their ticks are
                kept for next time.
              </p>
            ) : (
              <div className="text-muted-foreground flex flex-col gap-2">
                <p>When you turn this on:</p>
                <ul className="list-disc pl-5">
                  <li>
                    Everyone already on the team keeps the tools they use now, so nobody is locked
                    out. Untick what each person doesn&apos;t need.
                  </li>
                  <li>
                    Members stop seeing Money (sales figures, expenses, the budget) and the costs
                    and margins in Stock and Shipping. Someone who needs those can be made an admin.
                  </li>
                  <li>People you invite from then on start with no tools until you tick some.</li>
                  <li>Owners and admins keep every tool. Home and Messages stay open to all.</li>
                </ul>
              </div>
            )}
            <ToolsSwitchForm slug={tenant.slug} on={perPerson} />
          </CardContent>
        </Card>
      )}

      {manager && (
        <Card>
          <CardHeader>
            <CardTitle>Invite a teammate</CardTitle>
            <CardDescription>
              Admins can change settings and invite people. Members can use the tools.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            <InviteForm slug={tenant.slug} tools={perPerson ? choices : undefined} />

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
                          {perPerson && invite.role === "member" && (
                            <>
                              {" · "}
                              {invite.tools?.length
                                ? `Opens ${invite.tools.map(toolName).join(", ")}`
                                : invite.tools
                                  ? "No tools yet"
                                  : "No tools chosen"}
                            </>
                          )}
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
