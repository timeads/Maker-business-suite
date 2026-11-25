"use client";

import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { HELP_BUCKET } from "@/lib/helpdesk/help-centre/public";
import { getBrowserClient } from "@/lib/supabase/browser";
import {
  finishArticlePicture,
  removeArticlePicture,
  saveArticleDetails,
  saveArticlePicture,
  startArticlePicture,
} from "./help-actions";

const hint = "text-muted-foreground font-read text-xs";

/** A help article's address, category and the line shown in lists and search results. */
export function ArticleDetailsForm({
  slug,
  articleId,
  initial,
  categories,
  addressStart,
}: {
  slug: string;
  articleId: string;
  initial: { slug: string; category: string; summary: string };
  categories: { id: string; label: string }[];
  /** The part of the public address before the article's own: "example.com/help-centre/shop/". */
  addressStart: string;
}) {
  const [state, action] = useActionState(saveArticleDetails.bind(null, slug, articleId), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="help-summary">In a sentence</Label>
        <Input
          id="help-summary"
          name="summary"
          maxLength={300}
          defaultValue={initial.summary}
          placeholder="What this article helps with"
        />
        <p className={hint}>Shown under the title in lists and search results.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="help-category">Category</Label>
          <Select id="help-category" name="category" defaultValue={initial.category}>
            <option value="">None</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.label}
              </option>
            ))}
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="help-slug">Address</Label>
          <Input
            id="help-slug"
            name="slug"
            maxLength={80}
            defaultValue={initial.slug}
            placeholder="made from the title"
            autoCapitalize="none"
            spellCheck={false}
          />
          <p className={`${hint} break-all`}>
            {addressStart}
            <strong>{initial.slug || "…"}</strong>. An old address keeps working.
          </p>
        </div>
      </div>
      {state.error && <FormMessage>{state.error}</FormMessage>}
      {state.message && <FormMessage kind="success">{state.message}</FormMessage>}
      <div>
        <SubmitButton variant="outline" size="sm" pendingText="Saving…">
          Save details
        </SubmitButton>
      </div>
    </form>
  );
}

/** Adds pictures to an article: each goes straight to storage, then the server checks it. */
export function PictureUploader({ slug, articleId }: { slug: string; articleId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  async function send(files: File[]) {
    if (files.length === 0 || busy) return;
    setBusy(true);
    setNote(null);
    let added = 0;
    let trouble: string | null = null;
    for (const file of files.slice(0, 12)) {
      const started = await startArticlePicture(slug, articleId, {
        type: file.type,
        size: file.size,
      });
      if ("error" in started) {
        trouble = started.error;
        continue;
      }
      const { error } = await getBrowserClient()
        .storage.from(HELP_BUCKET)
        .uploadToSignedUrl(started.ticket.path, started.ticket.token, file, {
          contentType: file.type,
        });
      if (error) {
        trouble = "A picture didn't upload. Check your connection and try again.";
        continue;
      }
      const finished = await finishArticlePicture(slug, articleId, started.ticket.path);
      if ("error" in finished) trouble = finished.error;
      else added += 1;
    }
    setBusy(false);
    setNote(trouble);
    if (input.current) input.current.value = "";
    if (added > 0) router.refresh();
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif"
        multiple
        hidden
        onChange={(event) => send([...(event.target.files ?? [])])}
      />
      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? "Adding…" : "Add pictures"}
        </Button>
      </div>
      {note && <FormMessage>{note}</FormMessage>}
    </div>
  );
}

/** One of an article's pictures: what it shows, its caption, where it sits. */
export function PictureRow({
  slug,
  picture,
  headings,
  canEdit,
}: {
  slug: string;
  picture: {
    id: string;
    url: string;
    alt: string;
    caption: string;
    section: string;
    position: number;
  };
  headings: string[];
  canEdit: boolean;
}) {
  const [state, action] = useActionState(saveArticlePicture.bind(null, slug, picture.id), {});
  const known = headings.some((h) => h.toLowerCase() === picture.section.toLowerCase());
  return (
    <li className="border-border flex flex-col gap-3 border-t pt-3 first:border-t-0 first:pt-0 sm:flex-row">
      {/* eslint-disable-next-line @next/next/no-img-element -- the article's own picture, on our storage */}
      <img
        src={picture.url}
        alt={picture.alt}
        className="border-border bg-panel h-28 w-full rounded-md border object-contain sm:w-40"
      />
      <form action={action} className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor={`alt-${picture.id}`}>What it shows</Label>
            <Input
              id={`alt-${picture.id}`}
              name="alt"
              maxLength={200}
              defaultValue={picture.alt}
              placeholder="For people who can't see it"
              disabled={!canEdit}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`caption-${picture.id}`}>Caption</Label>
            <Input
              id={`caption-${picture.id}`}
              name="caption"
              maxLength={300}
              defaultValue={picture.caption}
              disabled={!canEdit}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`section-${picture.id}`}>Under</Label>
            <Select
              id={`section-${picture.id}`}
              name="section"
              defaultValue={known ? picture.section : ""}
              disabled={!canEdit}
            >
              <option value="">The start of the article</option>
              {headings.map((heading) => (
                <option key={heading} value={heading}>
                  {heading}
                </option>
              ))}
            </Select>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={`position-${picture.id}`}>Order</Label>
            <Input
              id={`position-${picture.id}`}
              name="position"
              type="number"
              min={0}
              max={999}
              defaultValue={picture.position}
              disabled={!canEdit}
            />
          </div>
        </div>
        {state.error && <FormMessage>{state.error}</FormMessage>}
        {state.message && <FormMessage kind="success">{state.message}</FormMessage>}
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            <SubmitButton variant="outline" size="sm" pendingText="Saving…">
              Save
            </SubmitButton>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              formAction={removeArticlePicture.bind(null, slug, picture.id)}
            >
              Remove
            </Button>
          </div>
        )}
      </form>
    </li>
  );
}
