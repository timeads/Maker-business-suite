import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { publicAssetUrl } from "@/lib/social/worker";
import { createClient } from "@/lib/supabase/server";
import { ProjectForm } from "../forms";
import { socialAccess } from "../gate";
import { composerChoices } from "../shared";
import { SocialTabs } from "../tabs";

export const metadata: Metadata = { title: "Projects" };

export default async function SocialProjectsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const access = await socialAccess(slug, `/w/${slug}/social/projects`);
  if (!access.ok) return access.upsell;
  const { tenant, entitlements } = access;
  const supabase = await createClient();
  const [{ data }, { data: photos }, { data: posts }, choices] = await Promise.all([
    supabase
      .from("social_projects")
      .select("id, name, note, archived_at, created_at")
      .eq("tenant_id", tenant.id)
      .order("created_at", { ascending: false })
      .limit(200),
    supabase
      .from("social_assets")
      .select("project_id, storage_path")
      .eq("tenant_id", tenant.id)
      .not("project_id", "is", null)
      .eq("hidden", false)
      .order("created_at", { ascending: false })
      .limit(1000),
    supabase
      .from("social_posts")
      .select("project_id, status")
      .eq("tenant_id", tenant.id)
      .not("project_id", "is", null)
      .limit(2000),
    composerChoices(supabase, tenant.id, []),
  ]);
  const projects = data ?? [];
  const cover = new Map<string, string>();
  const photoCount = new Map<string, number>();
  for (const photo of photos ?? []) {
    const id = photo.project_id as string;
    if (!cover.has(id)) cover.set(id, photo.storage_path as string);
    photoCount.set(id, (photoCount.get(id) ?? 0) + 1);
  }
  const postCount = new Map<string, number>();
  for (const post of posts ?? []) {
    const id = post.project_id as string;
    postCount.set(id, (postCount.get(id) ?? 0) + 1);
  }

  return (
    <>
      <PageHeader
        title="Social"
        description="A project gathers the photos and posts of one piece of work: a rug, a workshop, a series."
      />
      <SocialTabs slug={tenant.slug} />

      {projects.length > 0 && (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => (
            <li key={project.id}>
              <Link
                href={`/w/${tenant.slug}/social/projects/${project.id}`}
                className="bg-card border-border hover:border-ochre flex h-full flex-col overflow-hidden rounded-lg border transition-colors duration-150"
              >
                {cover.has(project.id as string) ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
                  <img
                    src={publicAssetUrl(cover.get(project.id as string)!)}
                    alt=""
                    loading="lazy"
                    className="aspect-[3/2] w-full object-cover"
                  />
                ) : (
                  <span className="bg-sunken text-muted-foreground flex aspect-[3/2] items-center justify-center text-xs">
                    No photos yet
                  </span>
                )}
                <span className="flex flex-col gap-1 p-4">
                  <span className="flex flex-wrap items-center gap-2 font-semibold">
                    {project.name}
                    {project.archived_at && <Badge>Finished</Badge>}
                  </span>
                  <span className="text-muted-foreground text-xs tabular-nums">
                    {photoCount.get(project.id as string) ?? 0} photos ·{" "}
                    {postCount.get(project.id as string) ?? 0} posts
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {entitlements.canWrite && (
        <Card>
          <CardHeader>
            <CardTitle>Start a project</CardTitle>
            <CardDescription>
              What you write about it helps Claude draft posts that get the details right.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProjectForm slug={tenant.slug} topics={choices.topics} />
          </CardContent>
        </Card>
      )}
    </>
  );
}
