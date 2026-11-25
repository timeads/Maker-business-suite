import type { Metadata } from "next";
import { WhereThingsLive } from "@/components/settings/where-things-live";

export const metadata: Metadata = { title: "Assistant settings" };

export default async function AssistantSettingsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <WhereThingsLive
      slug={slug}
      path="assistant"
      tool={{ href: "assistant", label: "Assistant" }}
      title="Assistant"
      description="What Claude can suggest for your workspace, and who says yes."
      pointers={[
        {
          name: "Suggestions waiting for a decision",
          about:
            "The Assistant only ever suggests a change. An owner or admin previews it and applies it, on the Assistant page.",
          href: "assistant",
        },
        {
          name: "Plan & billing",
          about: "How much the Assistant can do each month comes with your plan.",
          href: "settings/billing",
        },
        {
          name: "Brand kit",
          about: "The voice Claude writes in when it drafts for you.",
          href: "settings/brand",
        },
      ]}
    />
  );
}
