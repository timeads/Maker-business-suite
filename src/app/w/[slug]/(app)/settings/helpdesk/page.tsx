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
  describeActions,
  parseRules,
  parseTemplates,
} from "@/lib/helpdesk/config";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { SAVED_VIEWS_KEY, describeConditions, parseSavedViews } from "@/lib/helpdesk/saved-views";
import { DESK_SETTINGS_KEY, parseDeskSettings } from "@/lib/helpdesk/settings";
import {
  AddRuleForm,
  AddTemplateForm,
  AddViewForm,
  DeleteButton,
  DeskBehaviourForm,
  FolderForm,
  OwnAddressesForm,
} from "./forms";

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
  const [{ data }, { data: team }, { data: folderRows }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE),
    supabase.rpc("chat_people", { p_tenant_id: tenant.id }),
    supabase.from("ticket_folders").select("id, name").eq("tenant_id", tenant.id).order("name"),
  ]);
  const folders = (folderRows ?? []) as { id: string; name: string }[];
  const people = ((team ?? []) as Person[]).map((p) => ({ id: p.user_id, name: nameOf(p) }));
  const stored = new Map((data ?? []).map((row) => [row.key as string, row.body as unknown]));
  const templates = parseTemplates(stored.get(TEMPLATES_KEY)).templates;
  const rules = parseRules(stored.get(RULES_KEY)).rules;
  const views = parseSavedViews(stored.get(SAVED_VIEWS_KEY)).views;
  const desk = parseDeskSettings(stored.get(DESK_SETTINGS_KEY));
  const domain = inboundDomain();
  const personName = (id: string) => people.find((p) => p.id === id)?.name ?? "someone who left";

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
              {canEdit ? (
                <OwnAddressesForm slug={tenant.slug} addresses={desk.own_addresses} />
              ) : (
                desk.own_addresses.length > 0 && (
                  <p className="text-muted-foreground">
                    Your own addresses: {desk.own_addresses.join(", ")}
                  </p>
                )
              )}
            </>
          ) : (
            <p className="text-muted-foreground">
              Incoming email isn&apos;t switched on for this environment yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card id="behaviour" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>How the desk behaves</CardTitle>
          <CardDescription>
            A moment to take a sent email back, and where you land after closing a conversation.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <DeskBehaviourForm
              slug={tenant.slug}
              undoSeconds={desk.undo_seconds}
              afterClose={desk.after_close}
              autoOpen={desk.auto_open}
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              {desk.undo_seconds > 0
                ? `Sent email waits ${desk.undo_seconds} seconds before it goes.`
                : "Email goes as soon as it is sent."}{" "}
              Only owners and admins can change this.
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
                    {template.actions &&
                      describeActions(template.actions, personName).length > 0 && (
                        <p className="text-ochre-text mt-0.5 text-xs font-semibold">
                          When sent:{" "}
                          {describeActions(template.actions, personName)
                            .map((action) => action.label)
                            .join(" · ")}
                        </p>
                      )}
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
          {canEdit && <AddTemplateForm slug={tenant.slug} people={people} />}
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

      <Card id="folders" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Folders</CardTitle>
          <CardDescription>
            Somewhere to put conversations that are waiting on something, like a repair. A filed
            conversation leaves the inbox views and stays in its folder until it is closed or moved
            back. Anyone on the team can file; owners and admins make the folders.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {folders.length === 0 ? (
            <p className="text-muted-foreground text-sm">No folders yet.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {folders.map((folder) => (
                <li
                  key={folder.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2"
                >
                  {canEdit ? (
                    <FolderForm slug={tenant.slug} folder={folder} />
                  ) : (
                    <span className="text-sm font-semibold">{folder.name}</span>
                  )}
                  {canEdit && (
                    <DeleteButton
                      slug={tenant.slug}
                      id={folder.id}
                      kind="folder"
                      label={`Remove the ${folder.name} folder`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && <FolderForm slug={tenant.slug} />}
        </CardContent>
      </Card>

      <Card id="views" className="scroll-mt-6">
        <CardHeader>
          <CardTitle>Saved views</CardTitle>
          <CardDescription>
            A view is a filter with a name, kept in the help desk&apos;s menu for the whole team.
            You can also save one from the filter row above the list.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {views.length === 0 ? (
            <p className="text-muted-foreground text-sm">No saved views yet.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {views.map((view) => (
                <li key={view.id} className="flex items-start justify-between gap-3 py-2">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold">{view.name}</span>
                    <span className="text-muted-foreground block text-xs">
                      {describeConditions(view.conditions, {
                        person: (id) => people.find((p) => p.id === id)?.name ?? "someone who left",
                        folder: (id) =>
                          folders.find((f) => f.id === id)?.name ?? "a removed folder",
                      })}
                    </span>
                  </span>
                  {canEdit && (
                    <DeleteButton
                      slug={tenant.slug}
                      id={view.id}
                      kind="view"
                      label={`Remove the ${view.name} view`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
          {canEdit && <AddViewForm slug={tenant.slug} people={people} folders={folders} />}
        </CardContent>
      </Card>
    </>
  );
}
