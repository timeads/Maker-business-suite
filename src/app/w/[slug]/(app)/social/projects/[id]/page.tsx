import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { ProjectForm, UploadForm } from "../../forms";
import { socialAccess } from "../../gate";
import { STATUS_LABELS, composerChoices } from "../../shared";

export const metadata: Metadata = { title: "Project" };

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
  const [{ data: project }, { data: photos }, { data: posts }, choices] = await Promise.all([
    supabase
      .from("social_projects")
      .select("id, name, note, topic, archived_at")
      .eq("tenant_id", tenant.id)
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("social_assets")
      .select("id, storage_path, title")
      .eq("tenant_id", tenant.id)
      .eq("project_id", id)
      .eq("hidden", false)
      .order("created_at")
      .limit(300),
    supabase
      .from("social_posts")
      .select("id, caption, status, scheduled_for, planned_for")
      .eq("tenant_id", tenant.id)
      .eq("project_id", id)
      .order("created_at", { ascending: false })
      .limit(100),
    composerChoices(supabase, tenant.id, []),
  ]);
  if (!project) notFound();
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: tenant.timezone,
    month: "short",
    day: "numeric",
  });

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

      <Card>
        <CardHeader>
          <CardTitle>Photos, in the order they were added</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {(photos ?? []).length === 0 ? (
            <p className="text-muted-foreground text-sm">No photos in this project yet.</p>
          ) : (
            <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5 lg:grid-cols-6">
              {(photos ?? []).map((photo) => (
                <li key={photo.id}>
                  <Link href={`${base}/library?photo=${photo.id}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
                    <img
                      src={publicAssetUrl(photo.storage_path as string)}
                      alt={(photo.title as string) || "Photo"}
                      loading="lazy"
                      className="aspect-square w-full rounded-md object-cover"
                    />
                  </Link>
                </li>
              ))}
            </ul>
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
                      className="hover:bg-hover -mx-2 flex items-center gap-3 rounded-sm px-2 py-2 text-sm"
                    >
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
