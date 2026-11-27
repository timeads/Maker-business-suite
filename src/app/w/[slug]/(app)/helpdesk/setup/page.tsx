import type { Metadata } from "next";
import Link from "next/link";
import { NotNowButton } from "@/components/setup/not-now-button";
import { SetupList } from "@/components/setup/setup-list";
import { SetupStepCard } from "@/components/setup/setup-step";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { DESK_SETTINGS_KEY, parseDeskSettings } from "@/lib/helpdesk/settings";
import { HELPDESK_STEPS, HELPDESK_TOOL, helpdeskSetupItems } from "@/lib/helpdesk/setup";
import { loadHelpdeskSetupFacts } from "@/lib/helpdesk/setup-data";
import { CHANNEL_LABELS, SOCIAL_CHANNELS, type ChannelState } from "@/lib/helpdesk/social/channels";
import { loadNotNow } from "@/lib/setup/data";
import { firstOpenStep, openByStep, sortItems } from "@/lib/setup/items";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { OwnAddressesForm } from "../../settings/helpdesk/forms";

export const metadata: Metadata = { title: "Set up" };

const STATE: Record<ChannelState, { tone: "good" | "bad" | "closed"; words: string }> = {
  on: { tone: "good", words: "On" },
  blocked: { tone: "bad", words: "Switched on, can't come in" },
  off: { tone: "closed", words: "Off" },
};

/**
 * Help desk → Set up: the checklist as steps. The inbox is three full panes,
 * so the checklist lives here and as a count on the menu's Set up row rather
 * than as a card over the conversations. Each step writes through the help
 * desk's existing forms and settings; the automatic reply's words are only
 * ever written on its own form, so that step only links there. Everyone with
 * the help desk can look; what only owners and admins can change says so.
 */
export default async function HelpdeskSetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await helpdeskAccess(slug, `/w/${slug}/helpdesk/setup`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;
  const domain = inboundDomain();

  const supabase = await createClient();
  const [facts, notNow, { data: desk }] = await Promise.all([
    loadHelpdeskSetupFacts(supabase, tenant),
    loadNotNow(supabase, tenant.id, HELPDESK_TOOL),
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .eq("key", DESK_SETTINGS_KEY)
      .maybeSingle(),
  ]);
  const deskSettings = parseDeskSettings(desk?.body);

  const { open, resting } = sortItems(helpdeskSetupItems(facts), notNow);
  const steps = HELPDESK_STEPS;
  const current = firstOpenStep(steps, open);
  const byStep = openByStep(open);
  const stepProps = (id: string) => {
    const index = steps.findIndex((s) => s.id === id);
    return {
      id,
      number: index + 1,
      title: steps[index].title,
      open: byStep.get(id)?.length ?? 0,
      current: current === id,
      next: steps[index + 1]
        ? { id: steps[index + 1].id, title: steps[index + 1].title }
        : undefined,
    };
  };
  const stepItems = (id: string) => (
    <SetupList
      slug={tenant.slug}
      tool={HELPDESK_TOOL}
      items={byStep.get(id) ?? []}
      canSnooze={canEdit}
      canAct={canEdit}
    />
  );
  const link = (to: string, words: string, variant: "outline" | "ghost" = "outline") => (
    <Button asChild variant={variant} size="sm" className="w-fit">
      <Link href={`${base}/${to}`}>{words}</Link>
    </Button>
  );

  return (
    <>
      <PageHeader
        back={{ href: `${base}/helpdesk`, label: "Inbox" }}
        title="Set up"
        description="A few steps so every customer's message lands here and gets a quick answer. Skip anything, come back any time: this page remembers nothing but what you've already set."
      />

      {!manager && (
        <Card>
          <CardContent className="pt-6 text-sm">
            An owner or admin sets most of these up. You can see where things stand, and anything
            that&apos;s theirs to do says so.
          </CardContent>
        </Card>
      )}

      {/* 1. Email */}
      <SetupStepCard
        {...stepProps("email")}
        description="Email sent to the help desk's address becomes a conversation, and your replies go out from it."
      >
        {domain ? (
          <div className="flex flex-col gap-2 text-sm">
            <p className="bg-muted w-fit rounded px-2 py-1 font-mono text-sm break-all">
              {supportAddress(tenant.slug, domain)}
            </p>
            <p className="text-muted-foreground">
              Keep giving customers your own address, like hello@yourstudio.com, and set it to
              forward here. In Gmail that&apos;s Settings → Forwarding; other mail providers have
              the same setting under a similar name.
            </p>
            <p className="flex flex-wrap items-center gap-2">
              {facts.emailReceived ? (
                <Badge tone="good">Email is coming in</Badge>
              ) : facts.emailReceived === false ? (
                <Badge tone="waiting">Nothing has come in yet</Badge>
              ) : null}
            </p>
            {canEdit && (
              <OwnAddressesForm slug={tenant.slug} addresses={deskSettings.own_addresses} />
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Incoming email isn&apos;t switched on for this environment yet.
          </p>
        )}
        {stepItems("email")}
      </SetupStepCard>

      {/* 2. Replies */}
      <SetupStepCard
        {...stepProps("replies")}
        description="Saved replies for the answers you give often, rules that sort new email by itself, and a moment to take a sent email back."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            Saved replies: {facts.templates}. Rules for new email: {facts.rules}.
          </li>
          <li>
            {facts.undoSeconds > 0
              ? `A sent email waits ${facts.undoSeconds} seconds before it goes, so it can be taken back.`
              : "Email goes as soon as it's sent."}
          </li>
        </ul>
        {link("settings/helpdesk", "Open the help desk's settings")}
        {stepItems("replies")}
      </SetupStepCard>

      {/* 3. Instagram and Facebook */}
      <SetupStepCard
        {...stepProps("channels")}
        description="Messages and comments on your posts can sit beside email, through the same Facebook login Social posts with. Each is off until switched on."
      >
        <ul className="flex flex-col gap-1 text-sm">
          {SOCIAL_CHANNELS.flatMap((channel) =>
            (["messages", "comments"] as const).map((kind) => {
              const state = STATE[facts.social[kind][channel]];
              return (
                <li key={`${channel}.${kind}`} className="flex flex-wrap items-center gap-2">
                  {CHANNEL_LABELS[channel]} {kind}
                  <Badge tone={state.tone}>{state.words}</Badge>
                </li>
              );
            }),
          )}
        </ul>
        {!facts.social.offered && (
          <p className="text-muted-foreground text-sm">
            Instagram and Facebook aren&apos;t switched on for this environment yet.
          </p>
        )}
        {link("settings/helpdesk/channels", "See the channels")}
        {stepItems("channels")}
      </SetupStepCard>

      {/* 4. The automatic reply */}
      <SetupStepCard
        {...stepProps("automatic")}
        description="A short message sent by itself when someone writes in, always or only outside your opening hours. It's the words you write there and nothing else; nothing here writes them for you."
      >
        <p className="text-sm">
          {facts.autoReplyOn
            ? "An automatic reply is switched on."
            : "No automatic reply is switched on."}
        </p>
        {manager ? link("settings/helpdesk/auto-replies", "Automatic replies") : null}
        {stepItems("automatic")}
      </SetupStepCard>

      {/* 5. Manual and help centre */}
      <SetupStepCard
        {...stepProps("manual")}
        description="Topics written up from finished conversations, for the team and the reply box, and public help pages for the articles you choose to publish. Nothing is published by itself."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>{facts.manual.saved ? "The manual is set up." : "The manual isn't set up yet."}</li>
          <li>{facts.helpCentre.on ? "The help centre is open." : "The help centre is closed."}</li>
        </ul>
        <div className="flex flex-wrap gap-2">
          {link("helpdesk/manual", "Open the manual")}
          {manager && link("settings/helpdesk/help-centre", "Help centre settings", "ghost")}
        </div>
        {stepItems("manual")}
      </SetupStepCard>

      {/* 6. The shop */}
      <SetupStepCard
        {...stepProps("shop")}
        description="With your shop connected, a customer's orders show beside their message, from what your shop sends us. The help desk works without it."
      >
        <p className="text-sm">
          {facts.shop?.status === "active"
            ? "Your shop is connected."
            : facts.shop?.status === "needs_reconnect"
              ? "Your shop needs connecting again."
              : "Your shop isn't connected."}
        </p>
        {canEdit && link("connections", "Go to Connections")}
        {stepItems("shop")}
      </SetupStepCard>

      {/* 7. Review */}
      <SetupStepCard {...stepProps("review")} description="Where things stand now.">
        {open.length === 0 ? (
          <p className="text-sm">Nothing left to set up.</p>
        ) : (
          <>
            <p className="text-sm font-medium">Still open</p>
            <SetupList
              slug={tenant.slug}
              tool={HELPDESK_TOOL}
              items={open}
              canSnooze={canEdit}
              canAct={canEdit}
            />
          </>
        )}
        {resting.length > 0 && (
          <details>
            <summary className="text-muted-foreground cursor-pointer text-sm">
              {manager ? "You" : "An owner or admin"} said &ldquo;not now&rdquo; to {resting.length}
            </summary>
            <ul className="mt-2 flex flex-col gap-2 text-sm">
              {resting.map((item) => (
                <li key={item.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{item.title}</span>
                  {canEdit && (
                    <NotNowButton
                      slug={tenant.slug}
                      tool={HELPDESK_TOOL}
                      item={item.id}
                      facts={item.facts}
                      back
                    />
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
        {link("helpdesk", "Back to the inbox")}
      </SetupStepCard>
    </>
  );
}
