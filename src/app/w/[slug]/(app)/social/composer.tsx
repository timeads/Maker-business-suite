"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/utils";
import { deletePost, draftPostCaption, savePost, type SocialState } from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

export type LibraryPhoto = { id: string; url: string; title: string };

export type ComposerPost = {
  id: string;
  caption: string;
  captions: Partial<Record<"facebook" | "instagram", string>>;
  channels: string[];
  photoIds: string[];
  projectId: string | null;
  topic: string | null;
  aiDraft: string | null;
  planned: boolean;
  day: string;
  time: string;
};

export function Composer({
  slug,
  post,
  defaults,
  timezone,
  facebook,
  instagram,
  library,
  projects,
  topics,
}: {
  slug: string;
  post?: ComposerPost;
  defaults: { day: string; time: string; topic?: string | null; projectId?: string | null };
  timezone: string;
  /** The connected Page's name, or null when nothing is connected. */
  facebook: string | null;
  /** The linked Instagram handle, or null. */
  instagram: string | null;
  /** Recent photos to pick from, plus any already on the post. */
  library: LibraryPhoto[];
  projects: { id: string; name: string }[];
  topics: { id: string; name: string }[];
}) {
  const [state, save] = useActionState(savePost.bind(null, slug, post?.id ?? null), {});
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [aiDraft, setAiDraft] = useState(post?.aiDraft ?? "");
  const [picked, setPicked] = useState<string[]>(post?.photoIds ?? []);
  const [own, setOwn] = useState({
    facebook: Boolean(post?.captions.facebook),
    instagram: Boolean(post?.captions.instagram),
  });
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const [draftState, draft, drafting] = useActionState<SocialState, FormData>(
    async (prev, formData) => {
      const result = await draftPostCaption(slug, prev, formData);
      if (result.draft) {
        setCaption(result.draft);
        setAiDraft(result.draft);
        captionRef.current?.focus();
      }
      return result;
    },
    {},
  );
  const connected = facebook !== null;
  const byId = new Map(library.map((photo) => [photo.id, photo]));
  const toggle = (id: string) =>
    setPicked((now) =>
      now.includes(id) ? now.filter((x) => x !== id) : now.length < 10 ? [...now, id] : now,
    );
  const move = (id: string, by: number) =>
    setPicked((now) => {
      const from = now.indexOf(id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= now.length) return now;
      const next = [...now];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });

  return (
    <form action={save} className="flex flex-col gap-6">
      <input type="hidden" name="ai_draft" value={aiDraft} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="brief">Want a first draft?</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="brief"
            name="brief"
            maxLength={1000}
            placeholder="What's the post about? e.g. new autumn colours, restock on Friday"
            className="sm:flex-1"
          />
          <Button type="submit" variant="outline" formAction={draft} disabled={drafting}>
            {drafting ? "Drafting…" : "Draft with Claude"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          The draft goes into the caption box for you to edit. Nothing is posted until you say so.
        </p>
        <FormMessage>{draftState.error}</FormMessage>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="caption">Caption</Label>
        <textarea
          id="caption"
          name="caption"
          ref={captionRef}
          rows={6}
          maxLength={2200}
          value={caption}
          onChange={(event) => setCaption(event.target.value)}
          className={textarea}
        />
        <p className="text-muted-foreground text-xs tabular-nums">{caption.length} / 2,200</p>
        {(["facebook", "instagram"] as const).map((channel) => {
          const name = channel === "facebook" ? "Facebook" : "Instagram";
          return (
            <div key={channel} className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name={`own_${channel}`}
                  checked={own[channel]}
                  onChange={(event) => setOwn({ ...own, [channel]: event.target.checked })}
                />
                Different words for {name}
              </label>
              {own[channel] && (
                <textarea
                  name={`caption_${channel}`}
                  rows={4}
                  maxLength={2200}
                  defaultValue={post?.captions[channel] ?? caption}
                  aria-label={`Caption for ${name}`}
                  className={textarea}
                />
              )}
            </div>
          );
        })}
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="pb-2 text-xs leading-tight font-semibold">
          Photos <span className="text-muted-foreground font-normal">({picked.length} of 10)</span>
        </legend>
        {picked.map((id) => (
          <input key={id} type="hidden" name="asset" value={id} />
        ))}
        {picked.length > 0 && (
          <ol className="flex flex-wrap gap-3">
            {picked.map((id, index) => {
              const photo = byId.get(id);
              return (
                <li key={id} className="flex w-24 flex-col gap-1">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
                  <img
                    src={photo?.url}
                    alt={photo?.title || `Photo ${index + 1}`}
                    className="border-border size-24 rounded-md border object-cover"
                  />
                  <span className="flex justify-between text-xs">
                    <button
                      type="button"
                      onClick={() => move(id, -1)}
                      disabled={index === 0}
                      aria-label="Move earlier"
                      className="disabled:opacity-30"
                    >
                      ←
                    </button>
                    <button
                      type="button"
                      onClick={() => toggle(id)}
                      className="text-brick hover:underline"
                    >
                      Remove
                    </button>
                    <button
                      type="button"
                      onClick={() => move(id, 1)}
                      disabled={index === picked.length - 1}
                      aria-label="Move later"
                      className="disabled:opacity-30"
                    >
                      →
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        {library.length > 0 && (
          <details>
            <summary className="text-ochre-text cursor-pointer text-sm font-medium">
              Pick from your photos
            </summary>
            <div className="mt-3 grid max-h-72 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 md:grid-cols-8">
              {library.map((photo) => (
                <button
                  key={photo.id}
                  type="button"
                  onClick={() => toggle(photo.id)}
                  aria-pressed={picked.includes(photo.id)}
                  aria-label={photo.title || "Photo"}
                  className={cn(
                    "overflow-hidden rounded-md border-2",
                    picked.includes(photo.id) ? "border-ochre" : "border-transparent",
                  )}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
                  <img
                    src={photo.url}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                </button>
              ))}
            </div>
          </details>
        )}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="photos">Add new photos</Label>
          <input
            id="photos"
            name="photos"
            type="file"
            multiple
            accept="image/jpeg,image/png"
            className="file:border-input text-sm file:mr-3 file:rounded-sm file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-semibold"
          />
          <p className="text-muted-foreground text-xs">
            JPEG or PNG, up to 5 MB each. Instagram needs JPEGs. Several photos become one
            swipe-through post.
          </p>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-xs leading-tight font-semibold">Post to</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="channel_facebook"
            defaultChecked={post?.channels.length ? post.channels.includes("facebook") : connected}
            disabled={!connected}
          />
          Facebook{facebook ? ` · ${facebook}` : ""}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="channel_instagram"
            defaultChecked={
              post?.channels.length ? post.channels.includes("instagram") : instagram !== null
            }
            disabled={instagram === null}
          />
          Instagram{instagram ? ` · @${instagram}` : ""}
        </label>
        {!connected ? (
          <p className="text-muted-foreground text-xs">
            Connect Facebook &amp; Instagram on the Connections page to schedule posts. You can
            still save drafts.
          </p>
        ) : (
          instagram === null && (
            <p className="text-muted-foreground text-xs">
              No Instagram business account is linked to this Facebook Page.
            </p>
          )
        )}
      </fieldset>

      {(projects.length > 0 || topics.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2">
          {topics.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="topic">Topic</Label>
              <Select id="topic" name="topic" defaultValue={post?.topic ?? defaults.topic ?? ""}>
                <option value="">No topic</option>
                {topics.map((topic) => (
                  <option key={topic.id} value={topic.id}>
                    {topic.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
          {projects.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="project">Project</Label>
              <Select
                id="project"
                name="project"
                defaultValue={post?.projectId ?? defaults.projectId ?? ""}
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="day">Date</Label>
            <Input id="day" name="day" type="date" defaultValue={post?.day ?? defaults.day} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="time">Time</Label>
            <Input id="time" name="time" type="time" defaultValue={post?.time ?? defaults.time} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          In your workspace&apos;s timezone ({timezone.replace(/_/g, " ")}).
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="keep_date" defaultChecked={post ? post.planned : true} />
          If I save this as a draft, keep it pencilled in for then
        </label>
      </div>

      <FormMessage>{state.error}</FormMessage>
      <div className="flex flex-wrap gap-3">
        <SubmitButton name="intent" value="schedule" pendingText="Saving…" disabled={!connected}>
          Schedule
        </SubmitButton>
        <SubmitButton name="intent" value="now" variant="outline" disabled={!connected}>
          Post now
        </SubmitButton>
        <SubmitButton name="intent" value="draft" variant="outline">
          Save as draft
        </SubmitButton>
      </div>
    </form>
  );
}

export function DeletePostForm({ slug, postId }: { slug: string; postId: string }) {
  const [state, action] = useActionState(deletePost.bind(null, slug, postId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="danger" size="sm" pendingText="Deleting…" className="w-fit">
        Delete this post
      </SubmitButton>
    </form>
  );
}
