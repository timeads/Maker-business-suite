import type { Metadata } from "next";
import { SectionHeading } from "@/components/settings/section-heading";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { MANUAL_KEY, parseManual } from "@/lib/helpdesk/manual/config";
import { SAVED_VIEWS_KEY, parseSavedViews } from "@/lib/helpdesk/saved-views";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { ManualSettingsForm } from "./form";

export const metadata: Metadata = { title: "Manual settings" };

/** Settings → Help desk → Manual: what it's called, what feeds it, when it runs. */
export default async function ManualSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/settings/helpdesk/manual`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data: configs }, { data: folders }, { data: tags }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .in("key", [MANUAL_KEY, SAVED_VIEWS_KEY]),
    supabase.from("ticket_folders").select("id, name").eq("tenant_id", tenant.id).order("name"),
    supabase.from("tags").select("name").eq("tenant_id", tenant.id).order("name").limit(200),
  ]);
  const body = (key: string) => (configs ?? []).find((row) => row.key === key)?.body;
  const config = parseManual(body(MANUAL_KEY));

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/helpdesk/manual`, label: config.name }}
        title="Manual"
        description="A place for what the team has learned from answering customers. Claude can write it up from finished conversations as drafts; a person publishes them."
      />
      <Card>
        <CardHeader>
          <CardTitle>How your manual works</CardTitle>
          <CardDescription>
            The words here are yours: call it what your team calls it, and sort topics by what
            matters in your work. Customers&apos; names, addresses and order numbers are kept out of
            topics. Nothing in it is shown to a customer unless someone puts it in a reply.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ManualSettingsForm
              slug={tenant.slug}
              config={config}
              folders={(folders ?? []) as { id: string; name: string }[]}
              views={parseSavedViews(body(SAVED_VIEWS_KEY)).views.map((view) => ({
                id: view.id,
                name: view.name,
              }))}
              knownTags={((tags ?? []) as { name: string }[]).map((tag) => tag.name)}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              {canManage(role)
                ? "This workspace is read-only just now, so these can't be changed."
                : "Owners and admins choose what feeds the manual and when it runs."}
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
