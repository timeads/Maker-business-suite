import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { PhotoForm, UploadForm } from "../forms";
import { socialAccess } from "../gate";
import { SocialTabs } from "../tabs";

export const metadata: Metadata = { title: "Photos" };

type Photo = {
  id: string;
  storage_path: string;
  title: string;
  tags: string[];
  project_id: string | null;
  hidden: boolean;
};

export default async function SocialLibraryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ tag?: string; photo?: string; put_away?: string }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/library`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/social/library`;
  const tag = (query.tag ?? "").toLowerCase().slice(0, 30);
  const putAway = query.put_away === "1";

  const supabase = await createClient();
  const [{ data }, { data: projectRows }] = await Promise.all([
    supabase
      .from("social_assets")
      .select("id, storage_path, title, tags, project_id, hidden")
      .eq("tenant_id", tenant.id)
      .eq("hidden", putAway)
      .order("created_at", { ascending: false })
      .limit(400),
    supabase
      .from("social_projects")
      .select("id, name")
      .eq("tenant_id", tenant.id)
      .is("archived_at", null)
      .order("name"),
  ]);
  const photos = (data ?? []) as Photo[];
  const projects = (projectRows ?? []) as { id: string; name: string }[];
  const tags = [...new Set(photos.flatMap((photo) => photo.tags ?? []))].sort();
  const shown = tag ? photos.filter((photo) => (photo.tags ?? []).includes(tag)) : photos;
  const open = photos.find((photo) => photo.id === query.photo) ?? null;
  const link = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const all = { tag: tag || null, put_away: putAway ? "1" : null, ...changes };
    for (const [key, value] of Object.entries(all)) if (value) next.set(key, value);
    const text = next.toString();
    return text ? `${base}?${text}` : base;
  };

  return (
    <>
      <PageHeader
        title="Social"
        description="Every photo you've added, ready to drop into a post."
      />
      <SocialTabs slug={tenant.slug} />

      {entitlements.canWrite && !putAway && (
        <Card>
          <CardHeader>
            <CardTitle>Add photos</CardTitle>
          </CardHeader>
          <CardContent>
            <UploadForm slug={tenant.slug} projects={projects} />
          </CardContent>
        </Card>
      )}

      <nav aria-label="Filter photos" className="flex flex-wrap gap-1">
        <Link
          href={link({ tag: null, photo: null })}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs",
            !tag ? "bg-teal font-semibold text-white" : "text-text-2 hover:bg-hover",
          )}
        >
          All {photos.length}
        </Link>
        {tags.map((name) => (
          <Link
            key={name}
            href={link({ tag: name, photo: null })}
            className={cn(
              "rounded-full px-2.5 py-1 text-xs",
              tag === name ? "bg-teal font-semibold text-white" : "text-text-2 hover:bg-hover",
            )}
          >
            {name}
          </Link>
        ))}
        <Link
          href={link({ put_away: putAway ? null : "1", tag: null, photo: null })}
          className="text-muted-foreground hover:bg-hover ml-auto rounded-full px-2.5 py-1 text-xs"
        >
          {putAway ? "Back to photos" : "Put away"}
        </Link>
      </nav>

      {open && entitlements.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>This photo</CardTitle>
            <CardDescription>
              <Link href={link({ photo: null })} className="hover:underline">
                Close
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-[14rem_1fr]">
            {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
            <img
              src={publicAssetUrl(open.storage_path)}
              alt={open.title || "The photo"}
              className="border-border w-full rounded-md border object-contain"
            />
            <PhotoForm
              key={open.id}
              slug={tenant.slug}
              photo={{
                id: open.id,
                title: open.title,
                tags: open.tags ?? [],
                projectId: open.project_id,
                hidden: open.hidden,
              }}
              projects={projects}
            />
          </CardContent>
        </Card>
      )}

      {shown.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {putAway
            ? "Nothing has been put away."
            : tag
              ? "No photos with that tag."
              : "No photos yet. Add some above, or attach them when you write a post."}
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
          {shown.map((photo) => (
            <li key={photo.id}>
              <Link
                href={link({ photo: photo.id })}
                className={cn(
                  "group relative block overflow-hidden rounded-md border-2",
                  open?.id === photo.id ? "border-ochre" : "border-transparent",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
                <img
                  src={publicAssetUrl(photo.storage_path)}
                  alt={photo.title || "Photo"}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
                {(photo.tags ?? []).length > 0 && (
                  <span className="absolute inset-x-1 bottom-1 flex flex-wrap gap-0.5">
                    {photo.tags.slice(0, 2).map((name) => (
                      <Badge key={name} tone="open">
                        {name}
                      </Badge>
                    ))}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
