"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/badge";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { BOX_KINDS, boxSize, type SavedBox } from "@/lib/shipping/labels";
import { archiveBox, makeDefaultBox, saveBox } from "./label-actions";

function BoxRow({ slug, box }: { slug: string; box: SavedBox }) {
  const [defaultState, defaultAction] = useActionState(makeDefaultBox.bind(null, slug, box.id), {});
  const [removeState, removeAction] = useActionState(archiveBox.bind(null, slug, box.id), {});
  const kind = BOX_KINDS.find((entry) => entry.key === box.kind)?.label ?? "Box";
  const empty = Number(box.empty_weight_oz);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1">
        <span className="font-medium">{box.name}</span>{" "}
        {box.is_default && <Badge tone="open">Usual box</Badge>}
        <span className="text-muted-foreground block text-xs">
          {kind} · {boxSize(box)}
          {empty > 0 ? ` · ${empty} oz empty` : ""}
        </span>
      </span>
      {!box.is_default && (
        <form action={defaultAction}>
          <SubmitButton variant="ghost" size="sm" pendingText="Saving…">
            Make it the usual
          </SubmitButton>
        </form>
      )}
      <form action={removeAction}>
        <SubmitButton variant="ghost" size="sm" pendingText="Removing…">
          Remove
        </SubmitButton>
      </form>
      {(defaultState.error || removeState.error) && (
        <span className="text-brick w-full text-xs">{defaultState.error ?? removeState.error}</span>
      )}
    </li>
  );
}

/** The boxes a workspace packs in, and a form to add one. */
export function BoxesForm({ slug, boxes }: { slug: string; boxes: SavedBox[] }) {
  const [state, action] = useActionState(saveBox.bind(null, slug), {});
  return (
    <div className="flex flex-col gap-5">
      {boxes.length > 0 ? (
        <ul className="divide-border border-border flex flex-col divide-y rounded-md border">
          {boxes.map((box) => (
            <BoxRow key={box.id} slug={slug} box={box} />
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-sm">
          No boxes yet. Add the ones you reach for most and they&apos;ll be one tap away when you
          buy a label.
        </p>
      )}
      <form action={action} className="flex flex-col gap-3">
        <fieldset className="flex flex-col gap-3">
          <legend className="mb-2 text-sm font-semibold">Add a box</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="box-name">What you call it</Label>
              <Input
                id="box-name"
                name="name"
                maxLength={60}
                placeholder="Small rug box"
                required
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="box-kind">Kind</Label>
              <Select id="box-kind" name="kind" defaultValue="box">
                {BOX_KINDS.map((kind) => (
                  <option key={kind.key} value={kind.key}>
                    {kind.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ["length", "Length (in)"],
                ["width", "Width (in)"],
                ["height", "Height (in)"],
              ] as const
            ).map(([name, label]) => (
              <div key={name} className="flex flex-col gap-1.5">
                <Label htmlFor={`box-${name}`}>{label}</Label>
                <Input id={`box-${name}`} name={name} inputMode="decimal" maxLength={6} required />
              </div>
            ))}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="box-empty">Empty weight (oz)</Label>
              <Input id="box-empty" name="empty_weight" inputMode="decimal" maxLength={7} />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="default" />
            This is the box I use most
          </label>
        </fieldset>
        <FormMessage>{state.error}</FormMessage>
        <FormMessage kind="success">{state.message}</FormMessage>
        <SubmitButton variant="outline" pendingText="Adding…" className="sm:w-fit">
          Add box
        </SubmitButton>
      </form>
    </div>
  );
}
