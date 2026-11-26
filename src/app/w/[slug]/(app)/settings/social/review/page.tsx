import type { Metadata } from "next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/settings/section-heading";
import { approverWords } from "@/lib/social/review";
import { createClient } from "@/lib/supabase/server";
import { canManage } from "@/lib/tenants";
import { socialAccess } from "../../../social/gate";
import { ReviewSettingsForm } from "../../../social/review-forms";
import { reviewFor } from "../../../social/shared";

export const metadata: Metadata = { title: "Post review" };

/**
 * Settings → Social & emails → Post review: whether posts are approved before they go out,
 * and who approves them. Owners and admins change it; everyone can see how it is set.
 */
export default async function PostReviewSettings({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await socialAccess(slug, `/w/${slug}/settings/social/review`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const review = await reviewFor(supabase, tenant.id, role);
  const canEdit = canManage(role) && entitlements.canWrite;

  return (
    <>
      <SectionHeading
        back={{ href: `/w/${tenant.slug}/social/review`, label: "Social" }}
        title="Post review"
        description="A second pair of eyes before a post goes out: who approves, and whether every post needs it."
      />
      <Card>
        <CardHeader>
          <CardTitle>Approving posts</CardTitle>
          <CardDescription>
            Approving is always a person pressing Approve. Drafts Claude writes wait like any other
            draft until someone schedules or approves them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canEdit ? (
            <ReviewSettingsForm slug={tenant.slug} settings={review.settings} />
          ) : (
            <p className="text-muted-foreground text-sm">
              {review.required
                ? "Posts are approved before they can be scheduled."
                : "Anyone who can write can schedule; review is there for a second look."}{" "}
              {approverWords(review.settings)} can approve. An owner or admin can change this.
            </p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
