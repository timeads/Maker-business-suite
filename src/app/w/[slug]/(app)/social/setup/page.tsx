import type { Metadata } from "next";
import Link from "next/link";
import { NotNowButton } from "@/components/setup/not-now-button";
import { SetupList } from "@/components/setup/setup-list";
import { SetupStepCard } from "@/components/setup/setup-step";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { loadNotNow } from "@/lib/setup/data";
import { firstOpenStep, openByStep, sortItems } from "@/lib/setup/items";
import { SOCIAL_STEPS, SOCIAL_TOOL, socialSetupItems } from "@/lib/social/setup";
import { loadSocialSetupFacts } from "@/lib/social/setup-data";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { AllowMetaAccess } from "../../settings/helpdesk/channels/form";
import { socialAccess } from "../gate";

export const metadata: Metadata = { title: "Set up" };

/**
 * Social → Set up: the checklist as steps. Each step points at, or holds,
 * Social's existing forms (the brand kit, the Facebook login, the accounts,
 * the plan, review). The monthly run is only ever switched on by a person on
 * the plan page: this page explains it and links there. Everyone with Social
 * can look; what only owners and admins can change says so.
 */
export default async function SocialSetupPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/setup`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const manager = canManage(role);
  const canEdit = manager && entitlements.canWrite;
  const base = `/w/${tenant.slug}`;

  const supabase = await createClient();
  const [facts, notNow] = await Promise.all([
    loadSocialSetupFacts(supabase, tenant, { deep: true }),
    loadNotNow(supabase, tenant.id, SOCIAL_TOOL),
  ]);

  const { open, resting } = sortItems(socialSetupItems(facts), notNow);
  const steps = SOCIAL_STEPS;
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
      tool={SOCIAL_TOOL}
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
  const meta = facts.meta;
  const needsPosting = meta?.status === "active" && !meta.canPostFacebook && !meta.canPostInstagram;

  return (
    <>
      <PageHeader
        title="Set up"
        description="A few steps so your posts go out in your own look, to the right accounts. Skip anything, come back any time: this page remembers nothing but what you've already set."
      />

      {!manager && (
        <Card>
          <CardContent className="pt-6 text-sm">
            An owner or admin sets most of these up. You can see where things stand, and anything
            that&apos;s theirs to do says so.
          </CardContent>
        </Card>
      )}

      {/* 1. Brand */}
      <SetupStepCard
        {...stepProps("brand")}
        description="Your colours, fonts and voice. Drafts, emails and slides all start from your main brand's kit."
      >
        <p className="text-sm">
          {facts.kitSaved ? "Your main brand's kit is saved." : "No brand kit saved yet."}
        </p>
        {manager && link("settings/brand", facts.kitSaved ? "See your brand kit" : "Make your kit")}
        {stepItems("brand")}
      </SetupStepCard>

      {/* 2. Accounts */}
      <SetupStepCard
        {...stepProps("accounts")}
        description="One Facebook login brings your Pages and their Instagram accounts; you choose which are used. TikTok and LinkedIn connect on their own."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li className="flex flex-wrap items-center gap-2">
            Facebook &amp; Instagram
            {!meta || meta.status === "disconnected" ? (
              <Badge tone="closed">Not connected</Badge>
            ) : meta.status === "needs_reconnect" ? (
              <Badge tone="bad">Needs connecting again</Badge>
            ) : needsPosting ? (
              <Badge tone="waiting">Connected, posting not allowed</Badge>
            ) : (
              <Badge tone="good">Connected</Badge>
            )}
          </li>
          <li>
            Accounts in use: {facts.metaAccounts} on Facebook and Instagram
            {facts.otherAccounts > 0 ? `, ${facts.otherAccounts} on TikTok or LinkedIn` : ""}.
          </li>
        </ul>
        {needsPosting &&
          (canEdit ? (
            <AllowMetaAccess
              slug={tenant.slug}
              access="posting"
              returnTo="social"
              variant="outline"
              label="Allow posting on Facebook"
            />
          ) : (
            <p className="text-muted-foreground text-sm">
              An owner or admin can allow posting from here.
            </p>
          ))}
        <div className="flex flex-wrap gap-2">
          {canEdit && link("connections", "Go to Connections")}
          {manager && link("settings/social/accounts", "Choose accounts", "ghost")}
        </div>
        {stepItems("accounts")}
      </SetupStepCard>

      {/* 3. Plan */}
      <SetupStepCard
        {...stepProps("plan")}
        description="The topics you post about and the times you like to post. Claude drafts from them, always as drafts for a person to read."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>Topics: {facts.plan.topics}.</li>
          <li>
            The monthly run is {facts.plan.monthlyRunOn ? "on" : "off"}.{" "}
            {facts.plan.monthlyRunOn
              ? "On your review day the month ahead is drafted for you to read and change."
              : "It's off until an owner or admin switches it on on the plan page; nothing is posted without a person."}
          </li>
        </ul>
        {link("social/plan", "Open the plan")}
        {stepItems("plan")}
      </SetupStepCard>

      {/* 4. Review */}
      <SetupStepCard
        {...stepProps("review")}
        description="Out of the box anyone who can write can schedule. Switch approval on and only the people you choose can schedule; everyone else sends posts for review."
      >
        {manager && link("settings/social/review", "Post review settings")}
        {stepItems("review")}
      </SetupStepCard>

      {/* 5. Extras */}
      <SetupStepCard
        {...stepProps("extras")}
        description="None of these are needed to post. Take them or leave them."
      >
        <ul className="flex flex-col gap-1 text-sm">
          <li>
            {facts.logo
              ? "A picture is tagged as your logo."
              : facts.logo === false
                ? "No picture is tagged as your logo yet."
                : "We couldn't look for your logo just now."}
          </li>
          <li>
            {facts.links.published
              ? "Your link page is published."
              : "Your link page isn't published."}
          </li>
        </ul>
        {stepItems("extras")}
      </SetupStepCard>

      {/* 6. Done */}
      <SetupStepCard {...stepProps("done")} description="Where things stand now.">
        {open.length === 0 ? (
          <p className="text-sm">Nothing left to set up.</p>
        ) : (
          <>
            <p className="text-sm font-medium">Still open</p>
            <SetupList
              slug={tenant.slug}
              tool={SOCIAL_TOOL}
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
                      tool={SOCIAL_TOOL}
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
        {link("social", "Back to the calendar")}
      </SetupStepCard>
    </>
  );
}
