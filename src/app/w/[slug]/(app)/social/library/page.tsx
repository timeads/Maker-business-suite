import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, FolderOpen } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";
import { PhotoForm } from "../forms";
import { socialAccess } from "../gate";
import { SocialTabs } from "../tabs";
import { AssetGrid, Folders, FolderTools, Uploader, type Asset } from "./assets";

export const metadata: Metadata = { title: "Assets" };

type Row = {
  id: string;
  storage_path: string;
  mime_type: string;
  bytes: number;
  title: string;
  tags: string[];
  project_id: string | null;
  folder_id: string | null;
  hidden: boolean;
};

const KINDS = [
  { id: "", name: "Everything" },
  { id: "photo", name: "Photos" },
  { id: "video", name: "Videos" },
] as const;

export default async function SocialAssetsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    folder?: string;
    kind?: string;
    tag?: string;
    q?: string;
    open?: string;
    put_away?: string;
  }>;
}) {
  const { slug } = await params;
  const query = await searchParams;
  const access = await socialAccess(slug, `/w/${slug}/social/library`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const base = `/w/${tenant.slug}/social/library`;
  const tag = (query.tag ?? "").toLowerCase().slice(0, 30);
  const kind = query.kind === "photo" || query.kind === "video" ? query.kind : "";
  const search = (query.q ?? "").trim().toLowerCase().slice(0, 60);
  const putAway = query.put_away === "1";

  const supabase = await createClient();
  const [{ data }, { data: folderRows }, { data: projectRows }] = await Promise.all([
    supabase
      .from("social_assets")
      .select("id, storage_path, mime_type, bytes, title, tags, project_id, folder_id, hidden")
      .eq("tenant_id", tenant.id)
      .eq("hidden", putAway)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase.from("social_folders").select("id, name").eq("tenant_id", tenant.id).order("name"),
    supabase
      .from("social_projects")
      .select("id, name")
      .eq("tenant_id", tenant.id)
      .is("archived_at", null)
      .order("name"),
  ]);
  const all = (data ?? []) as Row[];
  const projects = (projectRows ?? []) as { id: string; name: string }[];
  const folders = ((folderRows ?? []) as { id: string; name: string }[]).map((folder) => ({
    ...folder,
    count: all.filter((asset) => asset.folder_id === folder.id).length,
  }));
  const folder = folders.find((f) => f.id === query.folder) ?? null;
  const filtering = Boolean(tag || kind || search);

  // Inside a folder: its files. At the top: everything when searching, else what isn't filed.
  const pool = folder
    ? all.filter((asset) => asset.folder_id === folder.id)
    : filtering || folders.length === 0
      ? all
      : all.filter((asset) => !asset.folder_id);
  const tags = [...new Set(pool.flatMap((asset) => asset.tags ?? []))].sort();
  const shown = pool.filter(
    (asset) =>
      (!tag || (asset.tags ?? []).includes(tag)) &&
      (!kind || asset.mime_type.startsWith(kind === "video" ? "video/" : "image/")) &&
      (!search ||
        asset.title.toLowerCase().includes(search) ||
        (asset.tags ?? []).some((name) => name.includes(search))),
  );
  const open = all.find((asset) => asset.id === query.open) ?? null;

  const link = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams();
    const current = {
      folder: folder?.id ?? null,
      kind: kind || null,
      tag: tag || null,
      q: search || null,
      put_away: putAway ? "1" : null,
      ...changes,
    };
    for (const [key, value] of Object.entries(current)) if (value) next.set(key, value);
    const text = next.toString();
    return text ? `${base}?${text}` : base;
  };
  const pill = (active: boolean) =>
    cn(
      "rounded-full px-2.5 py-1 text-xs",
      active ? "bg-teal font-semibold text-white" : "text-text-2 hover:bg-hover",
    );
  const assets: Asset[] = shown.map((asset) => ({
    id: asset.id,
    url: publicAssetUrl(asset.storage_path),
    title: asset.title,
    tags: asset.tags ?? [],
    video: asset.mime_type.startsWith("video/"),
    bytes: asset.bytes,
  }));

  return (
    <>
      <PageHeader
        title="Social"
        description="Your photos and videos in one place, ready to drop into a post."
      />
      <SocialTabs slug={tenant.slug} />

      {folder ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={link({ folder: null, open: null })}
              className="text-text-2 flex items-center gap-1 text-sm hover:underline"
            >
              <ChevronLeft aria-hidden className="size-4" /> All assets
            </Link>
            <h2 className="flex items-center gap-1.5 text-base font-semibold">
              <FolderOpen aria-hidden className="text-teal size-5" /> {folder.name}
            </h2>
          </div>
          {entitlements.canWrite && <FolderTools slug={tenant.slug} folder={folder} />}
        </div>
      ) : (
        !putAway && (
          <Folders
            slug={tenant.slug}
            folders={folders}
            loose={all.filter((asset) => !asset.folder_id).length}
            canWrite={entitlements.canWrite}
          />
        )
      )}

      {entitlements.canWrite && !putAway && <Uploader slug={tenant.slug} folder={folder} />}

      <div className="flex flex-wrap items-center gap-2">
        <form action={base} className="flex items-center gap-2">
          {folder && <input type="hidden" name="folder" value={folder.id} />}
          {kind && <input type="hidden" name="kind" value={kind} />}
          {putAway && <input type="hidden" name="put_away" value="1" />}
          <Input
            type="search"
            name="q"
            defaultValue={search}
            placeholder="Search names and tags"
            aria-label="Search assets"
            className="w-56"
          />
        </form>
        <nav aria-label="Kind of file" className="flex gap-1">
          {KINDS.map((option) => (
            <Link
              key={option.id}
              href={link({ kind: option.id || null, open: null })}
              className={pill(kind === option.id)}
            >
              {option.name}
            </Link>
          ))}
        </nav>
        <Link
          href={link({ put_away: putAway ? null : "1", tag: null, open: null, folder: null })}
          className="text-muted-foreground hover:bg-hover ml-auto rounded-full px-2.5 py-1 text-xs"
        >
          {putAway ? "Back to assets" : "Put away"}
        </Link>
      </div>
      {tags.length > 0 && (
        <nav aria-label="Filter by tag" className="flex flex-wrap gap-1">
          <Link href={link({ tag: null, open: null })} className={pill(!tag)}>
            All tags
          </Link>
          {tags.map((name) => (
            <Link key={name} href={link({ tag: name, open: null })} className={pill(tag === name)}>
              {name}
            </Link>
          ))}
        </nav>
      )}

      {open && entitlements.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>
              {open.mime_type.startsWith("video/") ? "This video" : "This photo"}
            </CardTitle>
            <CardDescription>
              <Link href={link({ open: null })} scroll={false} className="hover:underline">
                Close
              </Link>
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-[16rem_1fr]">
            {open.mime_type.startsWith("video/") ? (
              <video
                src={publicAssetUrl(open.storage_path)}
                controls
                playsInline
                preload="metadata"
                className="border-border w-full rounded-md border"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
              <img
                src={publicAssetUrl(open.storage_path)}
                alt={open.title || "The photo"}
                className="border-border w-full rounded-md border object-contain"
              />
            )}
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

      {assets.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {putAway
            ? "Nothing has been put away."
            : filtering
              ? "Nothing matches that."
              : folder
                ? "This folder is empty. Drop files above, or tick some in your library and move them here."
                : all.length > 0
                  ? "Everything is filed in a folder."
                  : "Nothing here yet. Drop your first photos or videos above."}
        </p>
      ) : (
        <AssetGrid
          slug={tenant.slug}
          assets={assets}
          folders={folders}
          canWrite={entitlements.canWrite}
          openId={open?.id ?? null}
          hrefFor={Object.fromEntries(assets.map((asset) => [asset.id, link({ open: asset.id })]))}
          putAway={putAway}
        />
      )}
    </>
  );
}
