"use client";

import { useActionState } from "react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { TopicMedia } from "@/lib/helpdesk/manual/data";
import {
  captionTopicMedia,
  copyTopicFor,
  dismissTopicMedia,
  joinTopic,
  keepTopicMedia,
  moveTopicMedia,
} from "./topic-actions";

/** The file itself, through the help desk's own route: only for the signed-in team. */
const fileUrl = (attachmentId: string) => `/api/helpdesk/files/${attachmentId}`;

function Preview({ media, tall = false }: { media: TopicMedia; tall?: boolean }) {
  const frame = `border-border bg-panel w-full rounded-md border object-contain ${tall ? "h-56" : "h-36"}`;
  return media.kind === "video" ? (
    <video
      src={fileUrl(media.attachmentId)}
      controls
      preload="metadata"
      playsInline
      aria-label={media.caption || media.name}
      className={frame}
    />
  ) : (
    <a href={fileUrl(media.attachmentId)} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element -- a private file, served by our own route */}
      <img src={fileUrl(media.attachmentId)} alt={media.caption || media.name} className={frame} />
    </a>
  );
}

/** One kept picture or video: its caption, its place in the row, and a way to take it off. */
export function KeptMedia({
  slug,
  topicId,
  media,
  first,
  last,
  canEdit,
}: {
  slug: string;
  topicId: string;
  media: TopicMedia;
  first: boolean;
  last: boolean;
  canEdit: boolean;
}) {
  const [state, action] = useActionState(captionTopicMedia.bind(null, slug, media.id), {});
  if (!canEdit) {
    return (
      <li className="flex flex-col gap-1.5">
        <Preview media={media} tall />
        {media.caption && <p className="font-read text-sm">{media.caption}</p>}
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-1.5">
      <Preview media={media} tall />
      <form action={action} className="flex flex-col gap-1.5">
        <Label htmlFor={`caption-${media.id}`} className="sr-only">
          Caption
        </Label>
        <Input
          id={`caption-${media.id}`}
          name="caption"
          maxLength={300}
          defaultValue={media.caption}
          placeholder="Caption"
        />
        {state.error && <FormMessage>{state.error}</FormMessage>}
        <div className="flex flex-wrap items-center gap-1">
          <SubmitButton variant="outline" size="sm" pendingText="Saving…">
            {state.message ? "Saved" : "Save caption"}
          </SubmitButton>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            disabled={first}
            aria-label="Move earlier"
            title="Move earlier"
            formAction={moveTopicMedia.bind(null, slug, topicId, media.id, -1)}
          >
            <ArrowLeft aria-hidden className="size-4" />
          </Button>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            disabled={last}
            aria-label="Move later"
            title="Move later"
            formAction={moveTopicMedia.bind(null, slug, topicId, media.id, 1)}
          >
            <ArrowRight aria-hidden className="size-4" />
          </Button>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            formAction={dismissTopicMedia.bind(null, slug, media.id)}
          >
            Remove
          </Button>
        </div>
      </form>
    </li>
  );
}

/** A picture or video a conversation offered: keep it (with a caption) or say no. */
export function CandidateMedia({ slug, media }: { slug: string; media: TopicMedia }) {
  const [state, action] = useActionState(keepTopicMedia.bind(null, slug, media.id), {});
  return (
    <li className="flex flex-col gap-1.5">
      <Preview media={media} />
      <form action={action} className="flex flex-col gap-1.5">
        <Label htmlFor={`keep-${media.id}`} className="sr-only">
          Caption
        </Label>
        <Input
          id={`keep-${media.id}`}
          name="caption"
          maxLength={300}
          defaultValue={media.caption}
          placeholder={media.kind === "video" ? "Caption for this video" : "Caption"}
        />
        {media.suggested && (
          <p className="text-muted-foreground font-read text-xs">
            Claude thinks this one helps, and suggested the caption. It&apos;s yours to change.
          </p>
        )}
        {state.error && <FormMessage>{state.error}</FormMessage>}
        <div className="flex flex-wrap gap-1">
          <SubmitButton variant="outline" size="sm" pendingText="Keeping…">
            Keep on this topic
          </SubmitButton>
          <Button
            type="submit"
            variant="ghost"
            size="sm"
            formAction={dismissTopicMedia.bind(null, slug, media.id)}
          >
            Not this one
          </Button>
        </div>
      </form>
    </li>
  );
}

/** "Copy for another <label>". */
export function CopyTopicForm({
  slug,
  topicId,
  facets,
}: {
  slug: string;
  topicId: string;
  facets: { id: string; label: string }[];
}) {
  const [state, action] = useActionState(copyTopicFor.bind(null, slug, topicId), {});
  const only = facets.length === 1 ? facets[0] : null;
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        {only ? (
          <input type="hidden" name="facet" value={only.id} />
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="copy-facet">Copy for another</Label>
            <Select id="copy-facet" name="facet" defaultValue={facets[0]?.id}>
              {facets.map((facet) => (
                <option key={facet.id} value={facet.id}>
                  {facet.label}
                </option>
              ))}
            </Select>
          </div>
        )}
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <Label htmlFor="copy-value">
            {only ? `Copy for another ${only.label.toLowerCase()}` : "Which one"}
          </Label>
          <Input id="copy-value" name="value" maxLength={60} required />
        </div>
        <SubmitButton variant="outline" size="sm" pendingText="Copying…">
          Make the copy
        </SubmitButton>
      </div>
      {state.error && <FormMessage>{state.error}</FormMessage>}
    </form>
  );
}

/** "Join into another topic". */
export function JoinTopicForm({
  slug,
  topicId,
  others,
}: {
  slug: string;
  topicId: string;
  others: { id: string; title: string }[];
}) {
  const [state, action] = useActionState(joinTopic.bind(null, slug, topicId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
          <Label htmlFor="join-into">Join this topic into</Label>
          <Select id="join-into" name="into" defaultValue="" required>
            <option value="" disabled>
              Choose a topic
            </option>
            {others.map((other) => (
              <option key={other.id} value={other.id}>
                {other.title}
              </option>
            ))}
          </Select>
        </div>
        <SubmitButton variant="outline" size="sm" pendingText="Joining…">
          Join them
        </SubmitButton>
      </div>
      {state.error && <FormMessage>{state.error}</FormMessage>}
    </form>
  );
}
