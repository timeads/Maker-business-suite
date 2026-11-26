"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { draftFromProject, redraftPost, restoreVersion, type DraftState } from "./draft-actions";

/** "Draft from this project": Claude writes a draft from the photos no post has used. */
export function DraftFromProjectForm({
  slug,
  projectId,
  brands,
  slides,
  ready,
}: {
  slug: string;
  projectId: string;
  /** With more than one brand, the person picks which one the draft is for. */
  brands: { id: string; name: string; main: boolean }[];
  /** The project's topic is made as slides. */
  slides: boolean;
  /** At least two photos haven't been posted. */
  ready: boolean;
}) {
  const [state, action] = useActionState<DraftState, FormData>(
    draftFromProject.bind(null, slug, projectId),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-3">
      {brands.length > 1 && (
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <Label htmlFor="draft-brand">For</Label>
          <Select
            id="draft-brand"
            name="brand_id"
            defaultValue={brands.find((b) => b.main)?.id ?? brands[0].id}
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </Select>
        </div>
      )}
      <div>
        <SubmitButton
          variant="outline"
          disabled={!ready}
          pendingText={slides ? "Designing the slides…" : "Writing…"}
        >
          Draft from this project
        </SubmitButton>
      </div>
      <p className="text-muted-foreground text-xs">
        {ready
          ? slides
            ? "Claude designs slides in your brand kit from this project's photos that haven't been posted, process shots in the order they were taken and the finished photos last, with a caption. It opens as a draft for you to change."
            : "Claude writes a caption for a carousel of this project's photos that haven't been posted: process shots in the order they were taken, then the finished photos. It opens as a draft for you to change."
          : "Add at least two photos that haven't been posted yet, then Claude can draft from them."}
      </p>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

/** "Write it again": Claude writes a draft it wrote before afresh; the old one is kept. */
export function RedraftForm({
  slug,
  postId,
  seen,
  slides,
}: {
  slug: string;
  postId: string;
  /** When the post was last saved, as the page read it. */
  seen: string;
  slides: boolean;
}) {
  const [state, action] = useActionState<DraftState, FormData>(
    redraftPost.bind(null, slug, postId),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="seen" value={seen} />
      <div>
        <SubmitButton variant="outline" size="sm" pendingText="Writing it again…">
          Write it again
        </SubmitButton>
      </div>
      <p className="text-muted-foreground text-xs">
        {slides
          ? "Claude writes new slides and a new caption. What's there now, your changes included, is kept below so you can bring it back."
          : "Claude writes a new caption for the same photos. What's there now, your changes included, is kept below so you can bring it back."}
      </p>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}

/** Brings an earlier version of the draft back. */
export function RestoreVersionForm({
  slug,
  postId,
  versionId,
}: {
  slug: string;
  postId: string;
  versionId: string;
}) {
  const [state, action] = useActionState<DraftState, FormData>(
    restoreVersion.bind(null, slug, postId, versionId),
    {},
  );
  return (
    <form action={action} className="flex flex-col gap-1">
      <div>
        <SubmitButton variant="ghost" size="sm" pendingText="Bringing it back…">
          Bring this back
        </SubmitButton>
      </div>
      <FormMessage>{state.error}</FormMessage>
    </form>
  );
}
