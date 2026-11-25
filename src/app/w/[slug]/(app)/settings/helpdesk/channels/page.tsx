import type { Metadata } from "next";
import Link from "next/link";
import { SectionHeading } from "@/components/settings/section-heading";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { helpdeskAccess } from "@/app/w/[slug]/helpdesk/gate";
import { inboundDomain, supportAddress } from "@/lib/helpdesk/addresses";
import { HELPDESK_MODULE } from "@/lib/helpdesk/config";
import {
  CHANNELS_KEY,
  CHANNEL_LABELS,
  SOCIAL_CHANNELS,
  channelState,
  parseChannelSettings,
  scopesAllow,
} from "@/lib/helpdesk/social/channels";
import { connectionFacts } from "@/lib/helpdesk/social/server";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { AllowMetaAccess, ChannelSwitches } from "./form";

export const metadata: Metadata = { title: "Help desk channels" };

/** Settings → Help desk → Channels: where conversations come from, and how each one stands. */
export default async function ChannelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await helpdeskAccess(slug, `/w/${slug}/settings/helpdesk/channels`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const canEdit = canManage(role) && entitlements.canWrite;
  const available = Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);

  const supabase = await createClient();
  const [{ data: config }, { data: row }] = await Promise.all([
    supabase
      .from("configs")
      .select("body")
      .eq("tenant_id", tenant.id)
      .eq("module", HELPDESK_MODULE)
      .eq("key", CHANNELS_KEY)
      .maybeSingle(),
    // Named columns only: members can't read the whole row.
    supabase
      .from("connections")
      .select("status, scopes, display_name, metadata")
      .eq("tenant_id", tenant.id)
      .eq("provider", "meta")
      .maybeSingle(),
  ]);
  const settings = parseChannelSettings(config?.body);
  const connection = row ? connectionFacts(row as Record<string, unknown>) : null;
  const live = connection !== null && connection.status !== "disconnected";
  const allowed =
    live &&
    (scopesAllow("facebook", connection.scopes) || scopesAllow("instagram", connection.scopes));
  const domain = inboundDomain();

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/helpdesk`, label: "Help desk" }}
        title="Channels"
        description="Where conversations come from. Email is always on; Instagram and Facebook messages can sit beside it and be answered from the same reply box."
      />
      {query.connected === "meta" && (
        <p role="status" className="bg-mint-soft rounded-md px-4 py-3 text-sm">
          Facebook &amp; Instagram is connected
          {query.warning
            ? ", but Facebook didn't confirm it will send messages here. Press Save below to ask again."
            : ". Tick the messages you want below and save."}
        </p>
      )}
      {query.error && (
        <p role="alert" className="bg-brick-soft rounded-md px-4 py-3 text-sm">
          {query.error === "declined"
            ? "Facebook wasn't given permission, so nothing changed."
            : query.error === "in_use"
              ? "That Facebook Page is already connected to another workspace."
              : "Connecting didn't finish. Try again in a moment."}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            Email <Badge tone="good">On</Badge>
          </CardTitle>
          <CardDescription>
            {domain ? (
              <>
                Mail sent to{" "}
                <span className="bg-sunken rounded px-1 py-0.5 font-mono text-xs break-all">
                  {supportAddress(tenant.slug, domain)}
                </span>{" "}
                becomes a conversation. Forwarding and your own addresses are under{" "}
                <Link href={`/w/${tenant.slug}/settings/helpdesk`} className="underline">
                  Inbox &amp; replies
                </Link>
                .
              </>
            ) : (
              "Incoming email isn't switched on for this environment yet."
            )}
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Instagram &amp; Facebook messages</CardTitle>
          <CardDescription>
            Messages people send your Instagram account or Facebook Page arrive as conversations,
            with the person&apos;s name or @handle. They use the same Facebook &amp; Instagram
            connection as Social, with extra permission to read and answer messages. A workspace
            that only posts is never asked for it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!available ? (
            <p className="text-muted-foreground text-sm">
              Instagram and Facebook messages aren&apos;t available in this environment yet.
            </p>
          ) : (
            <>
              <dl className="grid gap-3 sm:grid-cols-2">
                {SOCIAL_CHANNELS.map((channel) => {
                  const state = channelState(channel, settings, connection);
                  return (
                    <div key={channel} className="border-border rounded-md border px-3 py-2.5">
                      <dt className="flex flex-wrap items-center gap-2 text-sm font-bold">
                        {CHANNEL_LABELS[channel]}
                        <Badge
                          tone={
                            state.state === "on"
                              ? "good"
                              : state.state === "blocked"
                                ? "bad"
                                : "closed"
                          }
                        >
                          {state.state === "on"
                            ? "On"
                            : state.state === "blocked"
                              ? "Needs attention"
                              : "Off"}
                        </Badge>
                      </dt>
                      <dd className="text-muted-foreground mt-1 text-xs">
                        {state.why ??
                          (channel === "instagram"
                            ? connection?.instagramUsername
                              ? `@${connection.instagramUsername}`
                              : live
                                ? "No Instagram account is linked to the Page."
                                : "Not connected yet."
                            : (connection?.pageName ?? "Not connected yet."))}
                      </dd>
                    </div>
                  );
                })}
              </dl>

              {!canEdit ? (
                <p className="text-muted-foreground text-sm">
                  {canManage(role)
                    ? "This workspace is read-only just now, so these can't be changed."
                    : "Owners and admins switch channels on and off."}
                </p>
              ) : !allowed ? (
                <div className="flex flex-col gap-2">
                  <p className="text-sm">
                    {live
                      ? "Your Page is connected for posting. To bring messages in, Facebook needs to ask you for a little more: permission to read and send messages for the Page and its Instagram account."
                      : "Connect your Facebook Page (and the Instagram professional account linked to it), allowing messages when Facebook asks."}
                  </p>
                  <AllowMetaAccess
                    slug={tenant.slug}
                    access="messages"
                    returnTo="helpdesk_channels"
                    label={live ? "Allow messages on Facebook" : "Connect Facebook & Instagram"}
                  />
                  <p className="text-muted-foreground text-xs">
                    Leave every permission ticked on Facebook&apos;s screen. Posting keeps working
                    exactly as it does now.
                  </p>
                </div>
              ) : (
                <ChannelSwitches
                  slug={tenant.slug}
                  instagram={settings.instagram}
                  facebook={settings.facebook}
                  humanAgent={settings.human_agent}
                  canInstagram={Boolean(connection?.instagramId)}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Good to know</CardTitle>
        </CardHeader>
        <CardContent className="font-read flex max-w-prose flex-col gap-3 text-sm">
          <p>
            <strong>The 24-hour rule.</strong> Instagram and Facebook only let a business reply
            within 24 hours of the customer&apos;s last message. After that the reply box says so
            and won&apos;t send; you can still leave a note for the team, and you can reply again as
            soon as they write back.
          </p>
          <p>
            <strong>Send a test.</strong> From a personal account (not the business&apos;s own),
            message your Instagram account or Page. It should appear under “Instagram &amp;
            Facebook” in the help desk within a minute. If nothing arrives on Instagram, open the
            Instagram app and check Settings → Messages and story replies → Message controls →
            Connected tools → Allow access to messages.
          </p>
          <p>
            <strong>What goes out.</strong> Plain words, and JPEG or PNG pictures. Replies sent from
            the Instagram or Facebook app itself show up in the conversation too.
          </p>
          <p>
            <strong>Switching off.</strong> Untick a channel and save: new messages stop coming in,
            and the conversations you already have stay. To take the permission away altogether,
            disconnect Facebook &amp; Instagram under{" "}
            <Link href={`/w/${tenant.slug}/connections`} className="underline">
              Connections
            </Link>{" "}
            (that stops posting too).
          </p>
        </CardContent>
      </Card>
    </>
  );
}
