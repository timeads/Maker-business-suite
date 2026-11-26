import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormMessage } from "@/components/ui/form-message";
import { PageHeader } from "@/components/ui/page-header";
import { formatWhen } from "@/lib/bookings/slots";
import { approverWords } from "@/lib/social/review";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { socialAccess } from "../gate";
import { ReviewQueue, type QueueMonth } from "../review-forms";
import { loadDesignKit, reviewFor } from "../shared";
import { PostFilterBar, narrow, postFilterOf } from "../post-filter";
import { loadBrands } from "@/lib/brand/brands";
import type { BrandKit } from "@/lib/design/brands";

export const metadata: Metadata = { title: "Review" };

type Row = {
  id: string;
  caption: string;
  planned_for: string | null;
  asset_id: string | null;
  asset_ids: string[] | null;
  submitted_by: string | null;
  review: string;
  review_note: string | null;
  has_slides: unknown;
  brand_id: string | null;
};

const SAVED: Record<string, string> = {
  approved: "Approved and scheduled.",
  sent_back: "Sent back with your note.",
  review: "Sent for review.",
};

const snippet = (caption: string) => caption.replace(/\s+/g, " ").slice(0, 80) || "Photo post";

export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ saved?: string; brand?: string; account?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const { saved } = query;
  const filter = postFilterOf(query);
  const access = await socialAccess(slug, `/w/${slug}/social/review`);
  if (!access.ok) return access.upsell;
  const { tenant, role, entitlements } = access;
  const supabase = await createClient();
  const [{ data }, { data: members }, review, kit, brands, { data: runDrafts }] = await Promise.all(
    [
      narrow(
        supabase
          .from("social_posts")
          .select(
            "id, caption, planned_for, asset_id, asset_ids, submitted_by, review, review_note, brand_id",
          )
          .eq("tenant_id", tenant.id),
        filter,
      )
        .eq("status", "draft")
        .not("review", "is", null)
        .order("planned_for", { ascending: true, nullsFirst: false })
        .limit(300),
      supabase.rpc("list_members", { p_tenant_id: tenant.id }),
      reviewFor(supabase, tenant.id, role),
      loadDesignKit(supabase, tenant.id),
      loadBrands(supabase, tenant.id),
      // Where review isn't required, the monthly run's drafts are plain drafts: listed here too.
      narrow(
        supabase.from("social_posts").select("id, caption, planned_for").eq("tenant_id", tenant.id),
        filter,
      )
        .eq("status", "draft")
        .is("review", null)
        .not("month_run_id", "is", null)
        .order("planned_for", { ascending: true, nullsFirst: false })
        .limit(100),
    ],
  );
  const fromRun = (runDrafts ?? []) as {
    id: string;
    caption: string;
    planned_for: string | null;
  }[];
  // Each brand's kit, so a post's slides are drawn in its own brand when it is approved.
  const kits: Record<string, BrandKit | null> = {};
  if (brands.length > 1) {
    for (const brand of brands) kits[brand.id] = await loadDesignKit(supabase, tenant.id, brand.id);
  }
  const rows = (data ?? []) as unknown as Row[];
  const firstPhoto = (row: Row) => row.asset_ids?.[0] ?? row.asset_id;
  const photoIds = [...new Set(rows.map(firstPhoto).filter((id): id is string => Boolean(id)))];
  const { data: photos } = photoIds.length
    ? await supabase
        .from("social_assets")
        .select("id, storage_path, mime_type")
        .eq("tenant_id", tenant.id)
        .in("id", photoIds)
    : { data: [] };
  const photoUrl = new Map(
    ((photos ?? []) as { id: string; storage_path: string; mime_type: string }[])
      .filter((photo) => photo.mime_type.startsWith("image/"))
      .map((photo) => [photo.id, publicAssetUrl(photo.storage_path)]),
  );
  const emailOf = new Map(
    ((members ?? []) as { user_id: string; email: string }[]).map((m) => [m.user_id, m.email]),
  );

  const monthLabel = (iso: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tenant.timezone,
      month: "long",
      year: "numeric",
    }).format(new Date(iso));
  const monthKey = (iso: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tenant.timezone,
      year: "numeric",
      month: "2-digit",
    }).formatToParts(new Date(iso));
    return `${parts.find((p) => p.type === "year")?.value}-${parts.find((p) => p.type === "month")?.value}`;
  };

  const months: QueueMonth[] = [];
  for (const row of rows.filter((r) => r.review === "waiting")) {
    const month = row.planned_for ? monthKey(row.planned_for) : null;
    const label = row.planned_for ? monthLabel(row.planned_for) : "No time yet";
    let group = months.find((m) => m.label === label);
    if (!group) {
      group = { month, label, posts: [] };
      months.push(group);
    }
    const photo = firstPhoto(row);
    group.posts.push({
      id: row.id,
      snippet: snippet(row.caption),
      when: row.planned_for
        ? formatWhen(row.planned_for, row.planned_for, tenant.timezone).split(" – ")[0]
        : null,
      photo: photo ? (photoUrl.get(photo) ?? null) : null,
      by: row.submitted_by ? (emailOf.get(row.submitted_by) ?? null) : null,
      slides: row.has_slides != null,
      brandId: row.brand_id,
    });
  }
  const sentBack = rows.filter((r) => r.review === "sent_back");
  const waiting = months.reduce((n, m) => n + m.posts.length, 0);
  const canApprove = review.canApprove && entitlements.canWrite;

  return (
    <>
      <PageHeader
        title="Review"
        description={
          review.required
            ? `Posts wait here until they're approved. ${approverWords(review.settings)} can approve.`
            : `Posts someone wanted a second look at. ${approverWords(review.settings)} can approve.`
        }
      />
      <FormMessage kind="success">{SAVED[saved ?? ""]}</FormMessage>
      <PostFilterBar
        supabase={supabase}
        tenantId={tenant.id}
        action={`/w/${tenant.slug}/social/review`}
        filter={filter}
      />

      <Card>
        <CardHeader>
          <CardTitle>Waiting for review</CardTitle>
          <CardDescription>
            {waiting === 0
              ? "Nothing is waiting. Drafts sent for review show up here."
              : canApprove
                ? "Open one to read it and change it, or approve several at once. Each goes out at the time it's pencilled in for."
                : "An approver will look at these, then schedule them or send them back with a note."}
          </CardDescription>
        </CardHeader>
        {waiting > 0 && (
          <CardContent>
            <ReviewQueue
              slug={tenant.slug}
              months={months}
              canApprove={canApprove}
              kit={kit}
              kits={kits}
            />
          </CardContent>
        )}
      </Card>

      {fromRun.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Drafted for you this month</CardTitle>
            <CardDescription>
              The monthly run wrote these. Open each one, change what you like, then schedule it or
              send it for review.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y">
              {fromRun.map((row) => (
                <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-2">
                  <Link
                    href={`/w/${tenant.slug}/social/${row.id}`}
                    className="font-read min-w-0 flex-1 text-sm hover:underline"
                  >
                    {snippet(row.caption)}
                  </Link>
                  {row.planned_for && (
                    <span className="text-muted-foreground text-xs">
                      {
                        formatWhen(row.planned_for, row.planned_for, tenant.timezone).split(
                          " – ",
                        )[0]
                      }
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {sentBack.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Sent back</CardTitle>
            <CardDescription>
              Change what the note asks for, then send it for review again.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-border flex flex-col divide-y">
              {sentBack.map((row) => (
                <li key={row.id} className="py-2">
                  <Link
                    href={`/w/${tenant.slug}/social/${row.id}`}
                    className="font-read text-sm hover:underline"
                  >
                    {snippet(row.caption)}
                  </Link>
                  {row.review_note && (
                    <p className="bg-note font-read mt-1 rounded-sm px-3 py-2 text-xs">
                      {row.review_note}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </>
  );
}
