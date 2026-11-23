import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { workspaceTemplates } from "@/lib/brand/email";
import { BRAND_MODULE, KIT_KEY, parseBrandKit } from "@/lib/brand/kit";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { socialAccess } from "../gate";
import { SocialTabs } from "../tabs";
import { NewEmail } from "./new-email";
import { RowActions } from "./row-actions";

export const metadata: Metadata = { title: "Emails" };

export default async function EmailsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/emails`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements, role } = access;
  const supabase = await createClient();
  const [{ data: rows }, { data: kitRow }] = await Promise.all([
    supabase
      .from("emails")
      .select("id, title, updated_at")
      .eq("tenant_id", tenant.id)
      .order("updated_at", { ascending: false })
      .limit(100),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", BRAND_MODULE)
      .eq("key", KIT_KEY)
      .maybeSingle(),
  ]);
  const kit = parseBrandKit(kitRow?.body);
  const emails = (rows ?? []) as { id: string; title: string; updated_at: string }[];
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <>
      <PageHeader
        title="Social"
        description="Design an email in your brand, then copy it into whatever you send email with."
      />
      <SocialTabs slug={tenant.slug} />

      {entitlements.canWrite &&
        (kit ? (
          <Card>
            <CardHeader>
              <CardTitle>New email</CardTitle>
              <CardDescription>
                Each starter comes in your colours. Drag blocks around once it opens.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <NewEmail
                slug={tenant.slug}
                starters={workspaceTemplates(kit).map(({ id, name, about }) => ({
                  id,
                  name,
                  about,
                }))}
              />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Set up your brand kit first</CardTitle>
              <CardDescription>
                Emails are drawn in your colours, so we need to know them.
                {!canManage(role) && " Ask an owner or admin to set it up."}
              </CardDescription>
            </CardHeader>
            {canManage(role) && (
              <CardContent>
                <Button asChild>
                  <Link href={`/w/${tenant.slug}/settings/brand`}>Set up brand kit</Link>
                </Button>
              </CardContent>
            )}
          </Card>
        ))}

      {emails.length === 0 ? (
        <p className="text-muted-foreground text-sm">No emails yet.</p>
      ) : (
        <ul className="bg-card divide-border divide-y rounded-lg border">
          {emails.map((email) => (
            <li key={email.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Link
                href={`/w/${tenant.slug}/emails/${email.id}`}
                className="min-w-0 flex-1 truncate text-sm font-semibold hover:underline"
              >
                {email.title}
              </Link>
              <span className="text-muted-foreground text-xs">
                Edited {when.format(new Date(email.updated_at))}
              </span>
              {entitlements.canWrite && (
                <RowActions slug={tenant.slug} id={email.id} title={email.title} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
