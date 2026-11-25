import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { SectionHeading } from "@/components/settings/section-heading";
import { nameOf, type Person } from "@/lib/messages/format";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import {
  HELPDESK_MODULE,
  RULES_KEY,
  TEMPLATES_KEY,
  parseRules,
  parseTemplates,
} from "@/lib/helpdesk/config";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { AddRuleForm, AddTemplateForm, DeleteButton } from "./forms";

export const metadata: Metadata = { title: "Help desk settings" };

const WHERE_LABELS = {
  anywhere: "subject or message",
  subject: "subject",
  body: "message",
  from: "sender's address",
} as const;

export default async function HelpdeskSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/settings/helpdesk`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;

  const supabase = await createClient();
  const [{ data }, { data: team }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE),
    supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
  ]);
  const people = ((team ?? []) as Person[]).map((p) => ({ id: p.user_id, name: nameOf(p) }));
  const stored = new Map((data ?? []).map((row) => [row.key as string, row.body as unknown]));
  const templates = parseTemplates(stored.get(TEMPLATES_KEY)).templates;
  const rules = parseRules(stored.get(RULES_KEY)).rules;
  const domain = inboundDomain();

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/helpdesk`, label: "Help desk" }}
        title="Help desk"
        description="Your address, the replies you reuse, and what happens to new email on its own."
      />

      <Card>
        <CardHeader>
          <CardTitle>Your help desk address</CardTitle>
          <CardDescription>
            Email sent here becomes a conversation, and your replies go out from it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          {domain ? (
            <>
              <p className="bg-muted w-fit rounded px-2 py-1 font-mono text-sm">
                {supportAddress(tenant.slug, domain)}
              </p>
              <p className="text-muted-foreground">
                Already have a support address, like hello@yourstudio.com? Keep giving that one to
                customers, and set it to forward to the address above. In Gmail that&apos;s Settings
                → Forwarding; other mail providers have the same setting under a similar name.
              </p>
            </>
          ) : (
            <p className="text-muted-foreground">
              Incoming email isn&apos;t switched on for this environment yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Saved replies</CardTitle>
          <CardDescription>
            Answers you give often. Pick one when replying, and Claude follows their tone when it
            drafts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {templates.length === 0 ? (
            <p className="text-muted-foreground text-sm">No saved replies yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {templates.map((template) => (
                <li key={template.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{template.name}</p>
                    <p className="text-muted-foreground line-clamp-2 text-sm whitespace-pre-wrap">
                      {template.body}
                    </p>
                  </div>
                  {canEdit && (
                    <DeleteButton
                      slug={tenant.slug}
                      id={template.id}
                      kind="template"
                      label={`Remove saved reply ${template.name}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && <AddTemplateForm slug={tenant.slug} />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rules for new email</CardTitle>
          <CardDescription>
            Sort new conversations by the words they contain: tag them, mark them urgent, or hand
            them straight to the right person.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {rules.length === 0 ? (
            <p className="text-muted-foreground text-sm">No rules yet.</p>
          ) : (
            <ul className="divide-border divide-y">
              {rules.map((rule) => (
                <li key={rule.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                  <span>
                    <span className="font-read">“{rule.contains}”</span> in the{" "}
                    {WHERE_LABELS[rule.where]} →{" "}
                    <span className="inline-flex flex-wrap gap-1 align-middle">
                      {rule.tag && <Badge tone="open">{rule.tag}</Badge>}
                      {rule.priority && (
                        <Badge tone={rule.priority === "urgent" ? "bad" : "waiting"}>
                          {rule.priority}
                        </Badge>
                      )}
                      {rule.assign_to && (
                        <Badge>
                          to{" "}
                          {people.find((p) => p.id === rule.assign_to)?.name ?? "someone who left"}
                        </Badge>
                      )}
                    </span>
                  </span>
                  {canEdit && (
                    <DeleteButton
                      slug={tenant.slug}
                      id={rule.id}
                      kind="rule"
                      label={`Remove rule for ${rule.contains}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && <AddRuleForm slug={tenant.slug} people={people} />}
          {!canEdit && (
            <p className="text-muted-foreground text-sm">
              Only owners and admins can change these settings.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
