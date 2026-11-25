import type { Metadata } from "next";
import { WhereThingsLive } from "@/components/settings/where-things-live";

export const metadata: Metadata = { title: "Social & emails settings" };

export default async function SocialSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <WhereThingsLive
      slug={slug}
      path="social"
      feature="module.social"
      tool={{ href: "social", label: "Social" }}
      title="Social & emails"
      description="What you post about, your link page, and the look your posts and emails are drawn in."
      pointers={[
        {
          name: "Content plan",
          about: "Your topics and the times you post, on Social's Plan tab.",
          href: "social/plan",
        },
        {
          name: "Link page",
          about: "The one page with all your links, on Social's Link page tab.",
          href: "social/links",
        },
        {
          name: "Saved email sections",
          about: "Saved from inside the email builder: open any email under Social, Emails.",
          href: "social/emails",
        },
        {
          name: "Brand kit",
          about: "The colours and voice Claude drafts in, and your designs are drawn from.",
          href: "settings/brand",
        },
        {
          name: "Connections",
          about: "Connect or reconnect the accounts you post to.",
          href: "connections",
        },
      ]}
    />
  );
}
