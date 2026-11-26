import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { loadBrands } from "@/lib/brand/brands";
import { asProjectPhoto, photosInUse, type LibraryAsset } from "@/lib/social/draft-context";
import { byTakenAt, chooseCarousel, projectTopic } from "@/lib/social/month";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { setPhotoRole } from "../../draft-actions";
import { DraftFromProjectForm } from "../../draft-forms";
import { ProjectForm, UploadForm } from "../../forms";
import { socialAccess } from "../../gate";
import { STATUS_LABELS, composerChoices } from "../../shared";

export const metadata: Metadata = { title: "Project" };

const ROLE_LABELS = {
  finished: "Finished photo",
  process: "Process shot",
  artwork: "Artwork",
} as const;
type Role = keyof typeof ROLE_LABELS;

export default async function SocialProjectPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { slug, id } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/projects/${id}`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const base = `/w/${tenant.slug}/social`;

  const supabase = await createClient();
  const [{ data: project }, { data: photoRows }, { data: posts }, choices, brands] =
    await Promise.all([
      supabase
        .from("social_projects")
        .select("id, name, note, topic, archived_at")
        .eq("tenant_id", tenant.id)
        .eq("id", id)
        .maybeSingle(),
      supabase
        .from("social_assets")
        .select("id, storage_path, mime_type, title, tags, project_id, created_at, taken_at, role")
        .like("mime_type", "image/%")
        .eq("tenant_id", tenant.id)
        .eq("project_id", id)
        .eq("hidden", false)
        .order("created_at")
        .limit(300),
      supabase
        .from("social_posts")
        .select("id, caption, status, scheduled_for, planned_for, photos_show")
        .eq("tenant_id", tenant.id)
        .eq("project_id", id)
        .order("created_at", { ascending: false })
        .limit(100),
      composerChoices(supabase, tenant.id, []),
      loadBrands(supabase, tenant.id),
    ]);
  if (!project) notFound();
  const photos = ((photoRows ?? []) as LibraryAsset[]).sort((a, b) =>
    byTakenAt(asProjectPhoto(a), asProjectPhoto(b)),
  );
  const used = await photosInUse(supabase, tenant.id, photos);
  const ready = chooseCarousel(photos.map(asProjectPhoto), used).length > 0;
  const unposted = photos.filter((p) => !used.has(p.id) && p.role !== "artwork").length;
  const { plan } = choices;
  const topicId =
    plan.topics.find((t) => t.id === project.topic)?.id ??
    projectTopic({ id, name: "", note: "", topic: (project.topic as string | null) ?? null }, plan);
  const asSlides = plan.topics.find((t) => t.id === topicId)?.makes === "slides";
  const sees = (posts ?? []).find((post) => post.photos_show)?.photos_show as string | undefined;

  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
  });
  const finished = photos.filter((p) => p.role === "finished");
  const artwork = photos.filter((p) => p.role === "artwork");
  const process = photos.filter((p) => p.role !== "finished" && p.role !== "artwork");
  const firstTaken = process.find((p) => p.taken_at)?.taken_at;
  const lastTaken = [...process].reverse().find((p) => p.taken_at)?.taken_at;
  const span =
    firstTaken && lastTaken
      ? day.format(new Date(firstTaken)) === day.format(new Date(lastTaken))
        ? day.format(new Date(firstTaken))
        : `${day.format(new Date(firstTaken))} to ${day.format(new Date(lastTaken))}`
      : null;
  const markAction = setPhotoRole.bind(null, tenant.slug);

  const tiles = (list: LibraryAsset[]) => (
    <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
      {list.map((photo) => (
        <li key={photo.id} className="flex flex-col gap-1">
          <Link href={`${base}/library?photo=${photo.id}`} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
            <img
              src={publicAssetUrl(photo.storage_path)}
              alt={photo.title || "Photo"}
              loading="lazy"
              className="aspect-square w-full rounded-md object-cover"
            />
            {used.has(photo.id) && (
              <span className="bg-card/90 absolute bottom-1 left-1 rounded-sm px-1.5 py-0.5 text-[11px] font-semibold">
                Posted
              </span>
            )}
          </Link>
          {entitlements.canWrite && (
            <details className="text-xs">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
                {photo.role ? ROLE_LABELS[photo.role as Role] : "Mark as…"}
              </summary>
              <form action={markAction} className="mt-1 flex flex-col items-start gap-0.5">
                <input type="hidden" name="asset" value={photo.id} />
                {(Object.keys(ROLE_LABELS) as Role[])
                  .filter((role) => role !== photo.role)
                  .map((role) => (
                    <Button
                      key={role}
                      type="submit"
                      name="role"
                      value={role}
                      variant="ghost"
                      size="sm"
                    >
                      {ROLE_LABELS[role]}
                    </Button>
                  ))}
                {photo.role && (
                  <Button type="submit" name="role" value="" variant="ghost" size="sm">
                    Clear the mark
                  </Button>
                )}
              </form>
            </details>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <PageHeader
        back={{ href: `${base}/projects`, label: "Projects" }}
        title={project.name as string}
        description={(project.note as string) || undefined}
      >
        {project.archived_at && <Badge>Finished</Badge>}
        {entitlements.canWrite && (
          <Button asChild variant="outline" size="sm">
            <Link
              href={`${base}/new?project=${project.id}${project.topic ? `&topic=${project.topic}` : ""}`}
            >
              Write a post about it
            </Link>
          </Button>
        )}
      </PageHeader>

      {entitlements.canWrite && !project.archived_at && (
        <Card>
          <CardHeader>
            <CardTitle>Draft from this project</CardTitle>
            <CardDescription>
              {unposted === 0
                ? "Every photo here is already on a post."
                : `${unposted} ${unposted === 1 ? "photo hasn't" : "photos haven't"} been posted yet.`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DraftFromProjectForm
              slug={tenant.slug}
              projectId={project.id as string}
              brands={brands
                .filter((b) => !b.archived_at)
                .map((b) => ({ id: b.id, name: b.name, main: b.is_default }))}
              slides={asSlides}
              ready={ready}
            />
          </CardContent>
        </Card>
      )}

      {sees && (
        <Card>
          <CardHeader>
            <CardTitle>What the photos show</CardTitle>
            <CardDescription>
              What Claude saw in this project&apos;s photos for its latest draft. If it&apos;s
              wrong, say so in the note below and the next draft will read it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="font-read text-sm">{sees}</p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Photos</CardTitle>
          <CardDescription>
            In the order they were taken (photos that don&apos;t say go by when they were added).
            Mark the finished photos and they close a carousel; artwork stays out of carousels.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {photos.length === 0 ? (
            <p className="text-muted-foreground text-sm">No photos in this project yet.</p>
          ) : (
            <>
              {finished.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">
                    Finished photos{" "}
                    <span className="text-muted-foreground font-normal tabular-nums">
                      · {finished.length}
                    </span>
                  </h2>
                  {tiles(finished)}
                </section>
              )}
              {process.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">
                    Process{" "}
                    <span className="text-muted-foreground font-normal tabular-nums">
                      · {process.length}
                      {span ? ` · ${span}` : ""}
                    </span>
                  </h2>
                  {tiles(process)}
                </section>
              )}
              {artwork.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h2 className="text-sm font-semibold">
                    Artwork{" "}
                    <span className="text-muted-foreground font-normal tabular-nums">
                      · {artwork.length}
                    </span>
                  </h2>
                  <p className="text-muted-foreground text-xs">
                    Kept with the project, left out of carousels.
                  </p>
                  {tiles(artwork)}
                </section>
              )}
            </>
          )}
          {entitlements.canWrite && (
            <UploadForm slug={tenant.slug} projects={[]} projectId={project.id as string} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Posts</CardTitle>
        </CardHeader>
        <CardContent>
          {(posts ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing posted about this yet.</p>
          ) : (
            <ul className="divide-border flex flex-col divide-y">
              {(posts ?? []).map((post) => {
                const at = (post.scheduled_for ?? post.planned_for) as string | null;
                return (
                  <li key={post.id}>
                    <Link
                      href={`${base}/${post.id}`}
                      className="hover:bg-hover -mx-2 flex flex-col gap-1 rounded-sm px-2 py-2 text-sm"
                    >
                      <span className="flex items-center gap-3">
                        <Badge tone={post.status === "published" ? "good" : "closed"}>
                          {STATUS_LABELS[post.status as string]}
                        </Badge>
                        <span className="font-read min-w-0 flex-1 truncate">
                          {(post.caption as string).replace(/\s+/g, " ") || "Photo"}
                        </span>
                        {at && (
                          <span className="text-muted-foreground tabular-nums">
                            {day.format(new Date(at))}
                          </span>
                        )}
                      </span>
                      {post.photos_show && (
                        <span className="text-muted-foreground text-xs">
                          Claude saw: {post.photos_show as string}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {entitlements.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>About this project</CardTitle>
          </CardHeader>
          <CardContent>
            <ProjectForm
              slug={tenant.slug}
              topics={choices.topics}
              project={{
                id: project.id as string,
                name: project.name as string,
                note: project.note as string,
                topic: project.topic as string | null,
                archived: Boolean(project.archived_at),
              }}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}
