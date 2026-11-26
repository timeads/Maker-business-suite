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
  commentAbilities,
  commentScopesAllow,
  commentState,
  parseChannelSettings,
  scopesAllow,
} from "@/lib/helpdesk/social/channels";
import { connectionFacts } from "@/lib/helpdesk/social/server";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { AllowMetaAccess, ChannelSwitches, CommentSwitches } from "./form";

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
  const commentsAllowed = {
    facebook: live && commentScopesAllow("facebook", connection.scopes),
    instagram: live && commentScopesAllow("instagram", connection.scopes),
  };
  const anyComments = commentsAllowed.facebook || commentsAllowed.instagram;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/helpdesk`, label: "Help desk" }}
        title="Channels"
        description="Where conversations come from. Email is always on; Instagram and Facebook messages, and comments on your posts, can sit beside it and be answered from the same reply box."
      />
      {query.connected === "meta" && (
        <p role="status" className="bg-mint-soft rounded-md px-4 py-3 text-sm">
          Facebook &amp; Instagram is connected
          {query.warning
            ? ", but Facebook didn't confirm it will send messages and comments here. Press Save below to ask again."
            : ". Tick what you want below and save."}
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
            that only posts is never asked for it. Each conversation is answered as the account the
            person wrote to; which Pages and Instagram accounts are used is under{" "}
            <Link href={`/w/${tenant.slug}/settings/social/accounts`} className="underline">
              Social accounts
            </Link>
            .
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
                  takeControl={settings.take_control}
                  canInstagram={Boolean(connection?.instagramId)}
                />
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card id="comments">
        <CardHeader>
          <CardTitle>Comments on your posts</CardTitle>
          <CardDescription>
            Comments people leave on your Instagram posts and reels, or on your Facebook Page&apos;s
            posts, can arrive as conversations too: one per person per post, with the post it is
            about. You can reply under the comment for everyone to see, or send one private message
            about it. Each platform is asked for separately, and only when you press its button
            here.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {!available ? (
            <p className="text-muted-foreground text-sm">
              Instagram and Facebook comments aren&apos;t available in this environment yet.
            </p>
          ) : (
            <>
              <dl className="grid gap-3 sm:grid-cols-2">
                {SOCIAL_CHANNELS.map((channel) => {
                  const state = commentState(channel, settings, connection);
                  const can = commentAbilities(channel, connection?.scopes ?? null);
                  return (
                    <div key={channel} className="border-border rounded-md border px-3 py-2.5">
                      <dt className="flex flex-wrap items-center gap-2 text-sm font-bold">
                        {CHANNEL_LABELS[channel]} comments
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
                          (!commentsAllowed[channel]
                            ? "Not allowed yet."
                            : !can.reply
                              ? "Comments can be read, but Facebook didn't give permission to reply, hide or delete."
                              : can.privately
                                ? "Reply publicly, message privately, hide and delete."
                                : "Reply publicly, hide and delete. A private message needs messages allowed too.")}
                      </dd>
                    </div>
                  );
                })}
              </dl>

              {!canEdit ? (
                <p className="text-muted-foreground text-sm">
                  {canManage(role)
                    ? "This workspace is read-only just now, so these can't be changed."
                    : "Owners and admins switch comments on and off."}
                </p>
              ) : (
                <>
                  {(!commentsAllowed.instagram || !commentsAllowed.facebook) && (
                    <div className="flex flex-col gap-2">
                      <p className="text-sm">
                        {live
                          ? "To bring comments in, Facebook needs to ask you for permission to read and answer them. Ask for one platform or both; what your connection already has is kept."
                          : "Connect your Facebook Page (and the Instagram professional account linked to it), allowing comments when Facebook asks."}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {!commentsAllowed.instagram && (
                          <AllowMetaAccess
                            slug={tenant.slug}
                            access="instagram_comments"
                            returnTo="helpdesk_channels"
                            variant="outline"
                            label="Allow Instagram comments"
                          />
                        )}
                        {!commentsAllowed.facebook && (
                          <AllowMetaAccess
                            slug={tenant.slug}
                            access="facebook_comments"
                            returnTo="helpdesk_channels"
                            variant="outline"
                            label="Allow Facebook comments"
                          />
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs">
                        Leave every permission ticked on Facebook&apos;s screen and pick the same
                        Page.
                      </p>
                    </div>
                  )}
                  {anyComments && (
                    <CommentSwitches
                      slug={tenant.slug}
                      instagram={settings.instagram_comments}
                      facebook={settings.facebook_comments}
                      canInstagram={commentsAllowed.instagram}
                      canFacebook={commentsAllowed.facebook}
                      filter={settings.comment_filter}
                      words={settings.comment_words}
                    />
                  )}
                </>
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
            Instagram app and check Settings → Messages and story replies → Message requests → Allow
            access to messages.
          </p>
          <p>
            <strong>Using another inbox tool as well.</strong> Instagram and Facebook let only one
            tool at a time answer a conversation: this one, another help desk, or Meta&apos;s own
            inbox. If a reply from here is refused with “another inbox tool is answering this
            conversation”, that tool has it. You choose which tool answers first in Meta Business
            Suite → Settings → Conversation routing (also under your Page&apos;s Settings → Page
            setup → Advanced messaging, and for Instagram → Instagram conversation routing): set the
            default app there, one for Instagram and one for Messenger. Whichever you don&apos;t
            choose still sees messages but can&apos;t reply, unless you allow it to “Take control of
            conversations” on the same screen. A reply Meta refuses is kept here to try again; it is
            never sent again by itself.
          </p>
          <p>
            <strong>An automatic first reply.</strong> The help desk can send a short message of
            your own by itself when someone writes, in place of the instant reply in Meta&apos;s
            inbox (which takes the conversation away from here). Set it up under{" "}
            <Link href={`/w/${tenant.slug}/settings/helpdesk/auto-replies`} className="underline">
              Automatic replies
            </Link>
            .
          </p>
          <p>
            <strong>What goes out.</strong> Plain words, and JPEG or PNG pictures. Replies sent from
            the Instagram or Facebook app itself show up in the conversation too.
          </p>
          <p>
            <strong>Comments are public.</strong> A reply under a comment can be read by everyone
            who can see the post, so the reply box says so and the button reads “Reply publicly”.
            For anything personal (an order, an address) choose “Message privately”: Instagram and
            Facebook allow one private message per comment, within seven days of it. If the person
            answers, it carries on as an ordinary message conversation.
          </p>
          <p>
            <strong>What isn&apos;t brought in.</strong> Your own posts and comments that don&apos;t
            answer a customer, likes and reactions, comments during an Instagram live broadcast, and
            mentions of you on other people&apos;s posts. Instagram only reports new comments: one a
            person later deletes stays here as it was.
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
