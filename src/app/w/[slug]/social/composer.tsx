"use client";

import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { deletePost, draftPostCaption, savePost, type SocialState } from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2";

export type ComposerPost = {
  id: string;
  caption: string;
  channels: string[];
  assetId: string | null;
  assetMime: string | null;
  assetUrl: string | null;
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
}: {
  slug: string;
  post?: ComposerPost;
  defaults: { day: string; time: string };
  timezone: string;
  /** The connected Page's name, or null when nothing is connected. */
  facebook: string | null;
  /** The linked Instagram handle, or null. */
  instagram: string | null;
}) {
  const [state, save] = useActionState(savePost.bind(null, slug, post?.id ?? null), {});
  const [caption, setCaption] = useState(post?.caption ?? "");
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const [draftState, draft, drafting] = useActionState<SocialState, FormData>(
    async (prev, formData) => {
      const result = await draftPostCaption(slug, prev, formData);
      if (result.draft) {
        setCaption(result.draft);
        captionRef.current?.focus();
      }
      return result;
    },
    {},
  );
  const connected = facebook !== null;

  return (
    <form action={save} className="flex flex-col gap-5">
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
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="photo">Photo</Label>
        {post?.assetUrl && (
          <div className="flex items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
            <img
              src={post.assetUrl}
              alt="The photo on this post"
              className="border-border size-24 rounded-md border object-cover"
            />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="remove_photo" /> Remove this photo
            </label>
          </div>
        )}
        <input type="hidden" name="asset_id" value={post?.assetId ?? ""} />
        <input type="hidden" name="asset_mime" value={post?.assetMime ?? ""} />
        <input
          id="photo"
          name="photo"
          type="file"
          accept="image/jpeg,image/png"
          className="text-sm file:mr-3 file:rounded-md file:border file:px-3 file:py-1.5 file:text-sm"
        />
        <p className="text-muted-foreground text-xs">
          JPEG or PNG, up to 5 MB. Instagram needs a JPEG.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-sm font-medium">Post to</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="channel_facebook"
            defaultChecked={post ? post.channels.includes("facebook") : connected}
            disabled={!connected}
          />
          Facebook{facebook ? ` · ${facebook}` : ""}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="channel_instagram"
            defaultChecked={post ? post.channels.includes("instagram") : instagram !== null}
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

      <div className="flex flex-col gap-2">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <Label htmlFor="day">Date</Label>
            <Input id="day" name="day" type="date" defaultValue={post?.day ?? defaults.day} />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="time">Time</Label>
            <Input id="time" name="time" type="time" defaultValue={post?.time ?? defaults.time} />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          In your workspace&apos;s timezone ({timezone.replace(/_/g, " ")}).
        </p>
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
      <SubmitButton variant="outline" pendingText="Deleting…" className="sm:w-fit">
        Delete this post
      </SubmitButton>
    </form>
  );
}
