import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { SectionHeading } from "@/components/settings/section-heading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth";
import { loadBrands } from "@/lib/brand/brands";
import { getEntitlements } from "@/lib/entitlements";
import { loginsOf } from "@/lib/connections/logins";
import { linkedinConfigured } from "@/lib/connections/providers/linkedin";
import { tiktokConfigured } from "@/lib/connections/providers/tiktok";
import { ACCOUNT_COLUMNS, accountsByPage, type AccountRow } from "@/lib/social/accounts";
import { createClient } from "@/lib/supabase/server";
import { canManage, getTenantContext } from "@/lib/tenants";
import { AllowMetaAccess } from "../../helpdesk/channels/form";
import { AccountsForm } from "../../../social/accounts-form";
import { ConnectLogin, ForgetLogin } from "../../../social/logins-form";

const LOGIN_NETWORKS = [
  {
    provider: "tiktok" as const,
    name: "TikTok",
    configured: tiktokConfigured,
    first: "Connect a TikTok account",
    another: "Add another TikTok account",
    about:
      "Each TikTok account is connected on its own: sign in to TikTok as that account. Videos go straight to it.",
  },
  {
    provider: "linkedin" as const,
    name: "LinkedIn",
    configured: linkedinConfigured,
    first: "Connect LinkedIn",
    another: "Add another LinkedIn person",
    about:
      "Sign in as someone who looks after your company page; their own profile is offered too. Add another person for pages only they look after.",
  },
];

export const metadata: Metadata = { title: "Social accounts" };

/**
 * Settings → Social & emails → Social accounts: which of the Pages and
 * Instagram accounts Facebook shared the workspace uses, and the brand each
 * belongs to. Social posts to them and the help desk answers as them.
 * Everyone can see the list; owners and admins change it.
 */
export default async function SocialAccountsSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const user = await requireUser(`/w/${slug}/settings/social/accounts`);
  const ctx = await getTenantContext(slug, user.id);
  if (!ctx) notFound();
  const entitlements = await getEntitlements(ctx.tenant.id);
  if (!entitlements.can("module.social") && !entitlements.can("module.helpdesk")) notFound();
  const supabase = await createClient();
  const [{ data: rows }, brands, { data: connection }, { data: loginRows }] = await Promise.all([
    supabase
      .from("social_accounts")
      .select(ACCOUNT_COLUMNS)
      .eq("tenant_id", ctx.tenant.id)
      .order("created_at"),
    loadBrands(supabase, ctx.tenant.id),
    supabase
      .from("connections")
      .select("status")
      .eq("tenant_id", ctx.tenant.id)
      .eq("provider", "meta")
      .maybeSingle(),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("provider, status, metadata")
      .eq("tenant_id", ctx.tenant.id)
      .in("provider", ["tiktok", "linkedin"]),
  ]);
  const loginConnections = new Map(
    ((loginRows ?? []) as { provider: string; status: string; metadata: unknown }[]).map((row) => [
      row.provider,
      row,
    ]),
  );
  const accounts = (rows ?? []) as AccountRow[];
  const canEdit = canManage(ctx.role) && entitlements.canWrite;
  const limit = entitlements.limit("social_accounts");
  const connected = connection?.status === "active";

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${ctx.tenant.slug}/social`, label: "Social" }}
        title="Social accounts"
        description="The Facebook Pages, Instagram, TikTok and LinkedIn accounts this workspace posts to (and answers Facebook and Instagram messages as), and which brand each one belongs to."
      />
      {accounts.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Nothing connected yet</CardTitle>
            <CardDescription>
              Connect Facebook & Instagram, TikTok or LinkedIn first. Every account you share with
              us shows up here.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href={`/w/${ctx.tenant.slug}/connections`}
              className="text-ochre-text text-sm font-semibold hover:underline"
            >
              Go to Connections
            </Link>
          </CardContent>
        </Card>
      ) : (
        <AccountsForm
          slug={ctx.tenant.slug}
          pages={accountsByPage(accounts)}
          brands={brands.map((brand) => ({
            id: brand.id,
            name: brand.name,
            archived: Boolean(brand.archived_at),
          }))}
          canEdit={canEdit}
        />
      )}
      {LOGIN_NETWORKS.filter(
        (network) => network.configured() || loginConnections.has(network.provider),
      ).map((network) => {
        const row = loginConnections.get(network.provider);
        const live = row?.status === "active" || row?.status === "needs_reconnect";
        const logins = live ? loginsOf(row?.metadata) : [];
        return (
          <Card key={network.provider}>
            <CardHeader>
              <CardTitle>{network.name}</CardTitle>
              <CardDescription>
                {network.about} Your plan uses up to {limit} at a time.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {logins.length > 0 && (
                <ul className="divide-border flex flex-col divide-y">
                  {logins.map((login) => {
                    const lost = accounts.some(
                      (account) =>
                        account.network === network.provider &&
                        account.login_id === login.id &&
                        account.needs_login,
                    );
                    return (
                      <li key={login.id} className="flex flex-wrap items-center gap-3 py-2">
                        <span className="min-w-48 flex-1 text-sm font-semibold">{login.name}</span>
                        {lost ? (
                          <Badge tone="bad">Needs connecting again</Badge>
                        ) : (
                          <Badge tone="good">Connected</Badge>
                        )}
                        {login.reconnect_by && (
                          <span className="text-muted-foreground text-xs">
                            {network.name} asks for it to be connected again by{" "}
                            {login.reconnect_by.slice(0, 10)}
                          </span>
                        )}
                        {canEdit && (
                          <ForgetLogin
                            slug={ctx.tenant.slug}
                            provider={network.provider}
                            loginId={login.id}
                            name={login.name}
                          />
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {canEdit && network.configured() && (
                <>
                  <ConnectLogin
                    slug={ctx.tenant.slug}
                    provider={network.provider}
                    network={network.name}
                    label={logins.length > 0 ? network.another : network.first}
                    variant="outline"
                  />
                  {logins.length > 0 && (
                    <p className="text-muted-foreground text-xs">
                      To connect one again (or after its access ran out), sign in as it again here.
                      New accounts arrive below unticked; the ones you use now carry on.
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
      <Card>
        <CardHeader>
          <CardTitle>Another Facebook Page or Instagram account?</CardTitle>
          <CardDescription>
            Connect again and tick every Page you want us to see when Facebook asks (an Instagram
            account comes with the Page it is linked to). New ones arrive here unticked; the ones
            you use now carry on as they are. Your plan uses up to {limit} of each kind at a time.
          </CardDescription>
        </CardHeader>
        {canEdit && connected && (
          <CardContent>
            <AllowMetaAccess
              slug={ctx.tenant.slug}
              label="Share more Pages with us"
              access=""
              returnTo="social_accounts"
              variant="outline"
            />
          </CardContent>
        )}
      </Card>
    </>
  );
}
