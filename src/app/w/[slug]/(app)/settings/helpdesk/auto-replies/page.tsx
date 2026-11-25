import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/settings/section-heading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { requireUser } from "@/lib/auth";
import { inboundDomain } from "@/lib/helpdesk/addresses";
import {
  AUTO_REPLIES_KEY,
  AUTO_REPLY_CHANNELS,
  parseAutoReplies,
  type AutoReplyChannel,
} from "@/lib/helpdesk/auto-reply/config";
import { AUTO_REPLY_LABELS, WHEN_LABELS, hoursWords } from "@/lib/helpdesk/auto-reply/form";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import { CHANNELS_KEY, channelState, parseChannelSettings } from "@/lib/helpdesk/social/channels";
import { connectionFacts } from "@/lib/helpdesk/social/server";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { AutoRepliesForm, SendTestForm } from "./form";

export const metadata: Metadata = { title: "Automatic replies" };

/**
 * Settings → Help desk → Automatic replies: a short message the help desk
 * sends by itself when someone writes in. The words are the ones saved here
 * and nothing else; no AI writes or changes them.
 */
export default async function AutoRepliesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const here = `/w/${slug}/settings/helpdesk/auto-replies`;
  const access = await helpdeskAccess(slug, here);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const user = await requireUser(here);

  const supabase = await createClient();
  const [{ data: configs }, { data: row }] = await Promise.all([
    supabase
      .from("configs")
      .select("key, body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .in("key", [AUTO_REPLIES_KEY, CHANNELS_KEY]),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("status, scopes, display_name, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "meta")
      .maybeSingle(),
  ]);
  const body = (key: string) => configs?.find((config) => config.key === key)?.body;
  const settings = parseAutoReplies(body(AUTO_REPLIES_KEY));
  const channels = parseChannelSettings(body(CHANNELS_KEY));
  const connection = row ? connectionFacts(row as Record<string, unknown>) : null;
  const mailReady = Boolean(inboundDomain());
  const channelsHref = `/w/${tenant.slug}/settings/helpdesk/channels`;

  // Why a channel that is ticked here still couldn't send, in a line.
  const ready: Record<AutoReplyChannel, string | null> = {
    instagram:
      channelState("instagram", channels, connection).state === "on"
        ? null
        : "Instagram messages aren't coming into the help desk yet, so nothing will be sent until they are (Settings → Help desk → Channels).",
    facebook:
      channelState("facebook", channels, connection).state === "on"
        ? null
        : "Facebook messages aren't coming into the help desk yet, so nothing will be sent until they are (Settings → Help desk → Channels).",
    email: mailReady ? null : "Incoming email isn't switched on for this environment yet.",
  };

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/helpdesk`, label: "Help desk" }}
        title="Automatic replies"
        description="A short message sent by itself when someone writes in, so they know it reached you. You write the words; they are sent exactly as you saved them."
      />

      <Card>
        <CardHeader>
          <CardTitle>Where things stand</CardTitle>
          <CardDescription>
            Each channel has its own switch and its own words. Everything is off until you tick it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-3">
            {AUTO_REPLY_CHANNELS.map((name) => {
              const channel = settings[name];
              const blocked = channel.on && ready[name] !== null;
              return (
                <div key={name} className="border-border rounded-md border px-3 py-2.5">
                  <dt className="flex flex-wrap items-center gap-2 text-sm font-bold">
                    {AUTO_REPLY_LABELS[name]}
                    <Badge tone={blocked ? "waiting" : channel.on ? "good" : "closed"}>
                      {blocked ? "On, but can't send yet" : channel.on ? "On" : "Off"}
                    </Badge>
                  </dt>
                  <dd className="text-muted-foreground mt-1 text-xs">
                    {channel.on ? WHEN_LABELS[channel.when] : "No automatic reply."}
                  </dd>
                </div>
              );
            })}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your automatic replies</CardTitle>
          <CardDescription>
            Under each message is how it will read. Comments on your posts never get an automatic
            reply: those are public.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AutoRepliesForm
            slug={tenant.slug}
            settings={settings}
            businessName={tenant.name}
            timeZone={tenant.timezone}
            canEdit={canEdit}
            ready={ready}
          />
        </CardContent>
      </Card>

      {canEdit && (
        <Card>
          <CardHeader>
            <CardTitle>Try the email reply on yourself</CardTitle>
            <CardDescription>
              Sends the saved email message to your own address so you can see it arrive. A real one
              comes from your support address, as a reply to the customer&apos;s email. For
              Instagram and Facebook there is no test send: the preview above is the message, and a
              test would have to go to a real person.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {user.email ? (
              <SendTestForm
                slug={tenant.slug}
                email={user.email}
                hasAway={settings.email.when !== "always"}
              />
            ) : (
              <p className="text-muted-foreground text-sm">
                Your account has no email address to send a test to.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent className="font-read flex max-w-prose flex-col gap-3 text-sm">
          <p>
            <strong>Only your words.</strong> The automatic reply is the message you saved, with the
            first name and your business&apos;s name filled in. Nothing writes or rewords it for
            you, and AI drafts are never sent by themselves.
          </p>
          <p>
            <strong>Say it&apos;s automatic.</strong> Instagram and Facebook ask businesses to tell
            people when a message is automated, and in some places (California and Germany among
            them) the law requires it. A few words do it: “This is an automatic reply”.
          </p>
          <p>
            <strong>When one is sent.</strong> Only for a message a person really sent you (a direct
            message, a story reply, a shared post, or an email): never for a comment, a like, a
            story mention, or anything in Spam or the Trash. One per person per channel in the quiet
            period above, and none once somebody on the team has answered.
          </p>
          <p>
            <strong>It doesn&apos;t count as an answer.</strong> The conversation stays open and
            waiting for a person, and shows in the thread as “Automatic reply”. Your reply-time
            figures are measured from the first answer a person sends.
          </p>
          <p>
            <strong>Replacing Meta&apos;s instant reply.</strong> If you have an instant reply or
            away message set up in Meta Business Suite (Inbox → Automations), switch this one on
            first, then switch Meta&apos;s off. While Meta&apos;s is on, Meta&apos;s inbox sends it,
            takes the conversation, and your replies from here can be refused with “another inbox
            tool is answering this conversation”. With both on, the customer could also get two
            automatic messages. If an automatic reply from here is refused for that reason, it is
            noted quietly on the conversation and not tried again; which tool answers first is
            chosen under{" "}
            <Link href={channelsHref} className="underline">
              Channels
            </Link>
            .
          </p>
          <p>
            <strong>Your hours this week.</strong> {hoursWords(settings.hours).join(" · ")}.
          </p>
        </CardContent>
      </Card>
    </>
  );
}
