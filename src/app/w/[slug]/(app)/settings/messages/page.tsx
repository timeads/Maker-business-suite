import type { Metadata } from "next";
import { WhereThingsLive } from "@/components/settings/where-things-live";

export const metadata: Metadata = { title: "Messages settings" };

export default async function MessagesSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <WhereThingsLive
      slug={slug}
      path="messages"
      feature="module.messages"
      tool={{ href: "messages", label: "Messages" }}
      title="Messages"
      description="Team chat, with heads-ups from your other tools."
      pointers={[
        {
          name: "Channels and direct messages",
          about: "Add a channel or start a direct message from inside Messages.",
          href: "messages",
        },
        {
          name: "People",
          about: "Everyone on the team can use Messages. Invite people under Settings, People.",
          href: "settings/team",
        },
      ]}
    />
  );
}
