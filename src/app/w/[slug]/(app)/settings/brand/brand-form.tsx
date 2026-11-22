"use client";

import { useActionState, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { FEELS, FEEL_LABELS, tidyHex, toDesignKit, type BrandKitConfig } from "@/lib/brand/kit";
import { cn } from "@/lib/utils";
import { saveKit, suggestKit, type BrandState } from "./actions";

const textarea =
  "border-input bg-card focus-visible:ring-ring w-full rounded-sm border px-3 py-2 text-sm outline-none focus-visible:ring-2";

type Way = "ask" | "guide" | "hand";
const WAYS: { id: Way; title: string; about: string }[] = [
  {
    id: "ask",
    title: "Build it with me",
    about: "Answer five questions and Claude suggests a kit.",
  },
  {
    id: "guide",
    title: "I have a brand guide",
    about: "Upload it and Claude reads the kit out of it.",
  },
  {
    id: "hand",
    title: "I'll fill it in myself",
    about: "Type your colours and voice straight in.",
  },
];

export function BrandKit({
  slug,
  kit,
  starter,
  canEdit,
  welcome,
}: {
  slug: string;
  /** The saved kit, if there is one. */
  kit: BrandKitConfig | null;
  /** What the editor starts from when nothing is saved. */
  starter: BrandKitConfig;
  canEdit: boolean;
  welcome: boolean;
}) {
  const [way, setWay] = useState<Way | null>(kit ? null : welcome ? "ask" : null);
  const [suggested, suggest] = useActionState<BrandState, FormData>(
    suggestKit.bind(null, slug),
    {},
  );
  const showEditor = Boolean(kit) || way === "hand" || Boolean(suggested.draft);

  return (
    <div className="flex flex-col gap-6">
      {canEdit && (
        <section aria-label="How to start" className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-3">
            {WAYS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={way === option.id}
                onClick={() => setWay(way === option.id ? null : option.id)}
                className={cn(
                  "bg-card rounded-lg border p-4 text-left transition-colors",
                  way === option.id ? "border-teal ring-teal ring-1" : "hover:bg-hover",
                )}
              >
                <span className="block text-sm font-semibold">{option.title}</span>
                <span className="text-muted-foreground mt-1 block text-sm">{option.about}</span>
              </button>
            ))}
          </div>

          {way === "ask" && (
            <form action={suggest} className="bg-card flex flex-col gap-4 rounded-lg border p-4">
              <input type="hidden" name="from" value="answers" />
              <Field label="What do you make?" hint="A sentence or two is plenty.">
                <textarea name="makes" rows={2} required maxLength={600} className={textarea} />
              </Field>
              <Field label="Who buys it?">
                <textarea name="customers" rows={2} maxLength={600} className={textarea} />
              </Field>
              <Field
                label="If your brand were a person, what would they be like?"
                hint="Funny? Calm? Straight-talking? A bit weird?"
              >
                <textarea name="personality" rows={2} maxLength={600} className={textarea} />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label="Colours you use or love"
                  hint="Names or codes. Leave blank if unsure."
                >
                  <Input
                    name="colours"
                    maxLength={300}
                    placeholder="forest green, cream, #b5532c"
                  />
                </Field>
                <Field label="The overall feel">
                  <Select name="feel" defaultValue="earthy">
                    {FEELS.map((feel) => (
                      <option key={feel} value={feel}>
                        {FEEL_LABELS[feel]}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <Field label="Your website" hint="Optional.">
                <Input name="site" maxLength={120} placeholder="yourshop.com" />
              </Field>
              <SubmitButton variant="dark" pendingText="Claude is thinking…" className="sm:w-fit">
                Suggest my brand kit
              </SubmitButton>
            </form>
          )}

          {way === "guide" && (
            <form action={suggest} className="bg-card flex flex-col gap-4 rounded-lg border p-4">
              <input type="hidden" name="from" value="guide" />
              <Field
                label="Your brand guide"
                hint="A PDF, or a PNG or JPEG of it, up to 5 MB. A one-page style sheet works well."
              >
                <input
                  type="file"
                  name="guide_file"
                  accept="application/pdf,image/png,image/jpeg"
                  className="text-sm"
                />
              </Field>
              <Field label="Or paste what it says">
                <textarea name="guide_text" rows={5} maxLength={20000} className={textarea} />
              </Field>
              <Field label="Your website" hint="Optional.">
                <Input name="site" maxLength={120} placeholder="yourshop.com" />
              </Field>
              <SubmitButton variant="dark" pendingText="Claude is reading…" className="sm:w-fit">
                Read my brand guide
              </SubmitButton>
            </form>
          )}
          <FormMessage>{suggested.error}</FormMessage>
        </section>
      )}

      {showEditor ? (
        <Editor
          key={suggested.draftId ?? "saved"}
          slug={slug}
          initial={suggested.draft ?? kit ?? starter}
          suggestion={Boolean(suggested.draft)}
          canEdit={canEdit}
        />
      ) : (
        !canEdit && (
          <p className="text-muted-foreground text-sm">
            No brand kit yet. An owner or admin can set one up here.
          </p>
        )
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs leading-tight font-semibold">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </label>
  );
}

type Swatch = { id: number; name: string; hex: string };

function Editor({
  slug,
  initial,
  suggestion,
  canEdit,
}: {
  slug: string;
  initial: BrandKitConfig;
  suggestion: boolean;
  canEdit: boolean;
}) {
  const [state, save] = useActionState<BrandState, FormData>(saveKit.bind(null, slug), {});
  const [name, setName] = useState(initial.name);
  const [tagline, setTagline] = useState(initial.tagline);
  const [feel, setFeel] = useState(initial.feel);
  const [colors, setColors] = useState<Swatch[]>(() =>
    initial.colors.map((color, id) => ({ id, ...color })),
  );
  const change = (id: number, patch: Partial<Swatch>) =>
    setColors((all) => all.map((c) => (c.id === id ? { ...c, ...patch } : c)));

  // The same pairing rules the designs use, so the preview is what you'll get.
  const preview = useMemo(() => {
    const usable = colors
      .map((c, index) => ({ name: `c${index}`, hex: tidyHex(c.hex) }))
      .filter((c): c is { name: string; hex: string } => c.hex !== null);
    if (usable.length < 2) return null;
    const kit = toDesignKit({ ...initial, name: name || "Your brand", feel, colors: usable });
    return usable.map((c) => ({
      bg: c.hex,
      ink: kit.palette[kit.pairings[c.name].ink],
      accent: kit.palette[kit.pairings[c.name].accent],
    }));
  }, [colors, feel, initial, name]);

  return (
    <form action={save} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <fieldset disabled={!canEdit} className="bg-card flex flex-col gap-5 rounded-lg border p-4">
        {suggestion && (
          <p className="bg-note rounded-sm px-3 py-2 text-sm">
            This is Claude&rsquo;s suggestion. Change anything you like; nothing is saved until you
            press <strong>Save brand kit</strong>.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Brand name">
            <Input
              name="name"
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field label="Website">
            <Input
              name="site"
              maxLength={120}
              defaultValue={initial.site}
              placeholder="yourshop.com"
            />
          </Field>
        </div>
        <Field label="Tagline" hint="The short line under your name, if you have one.">
          <Input
            name="tagline"
            maxLength={120}
            value={tagline}
            onChange={(e) => setTagline(e.target.value)}
          />
        </Field>
        <Field label="What you make and who it's for">
          <textarea
            name="about"
            rows={3}
            maxLength={800}
            defaultValue={initial.about}
            className={cn(textarea, "font-read")}
          />
        </Field>

        <div className="flex flex-col gap-2">
          <Label>Colours</Label>
          <p className="text-muted-foreground text-xs">
            The first is your main colour. Include one dark and one light so words stay readable.
          </p>
          <ul className="flex flex-col gap-2">
            {colors.map((color) => (
              <li key={color.id} className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label={`Pick ${color.name || "colour"}`}
                  value={tidyHex(color.hex) ?? "#000000"}
                  onChange={(e) => change(color.id, { hex: e.target.value })}
                  className="border-input size-9 shrink-0 cursor-pointer rounded-sm border bg-transparent p-0.5"
                />
                <Input
                  name="color_hex"
                  aria-label="Colour code"
                  value={color.hex}
                  onChange={(e) => change(color.id, { hex: e.target.value })}
                  maxLength={7}
                  className="w-28 font-mono"
                />
                <Input
                  name="color_name"
                  aria-label="Colour name"
                  value={color.name}
                  onChange={(e) => change(color.id, { name: e.target.value })}
                  maxLength={20}
                  placeholder="name"
                  className="min-w-0 flex-1"
                />
                {canEdit && colors.length > 2 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setColors((all) => all.filter((c) => c.id !== color.id))}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
          {canEdit && colors.length < 10 && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-fit"
              onClick={() =>
                setColors((all) => [
                  ...all,
                  { id: Math.max(...all.map((c) => c.id)) + 1, name: "", hex: "#888888" },
                ])
              }
            >
              Add a colour
            </Button>
          )}
        </div>

        <Field label="Overall feel" hint="Sets the shapes and type weight in your designs.">
          <Select name="feel" value={feel} onChange={(e) => setFeel(e.target.value as typeof feel)}>
            {FEELS.map((option) => (
              <option key={option} value={option}>
                {FEEL_LABELS[option]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="The look, in a sentence or two">
          <textarea
            name="look"
            rows={2}
            maxLength={400}
            defaultValue={initial.look}
            className={cn(textarea, "font-read")}
          />
        </Field>
        <Field
          label="How you sound"
          hint="Claude follows this when it drafts posts and emails for you."
        >
          <textarea
            name="voice"
            rows={5}
            maxLength={2000}
            defaultValue={initial.voice}
            className={cn(textarea, "font-read")}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Words you like" hint="Separate with commas.">
            <Input name="words_to_use" defaultValue={initial.words_to_use.join(", ")} />
          </Field>
          <Field label="Words you never use" hint="Separate with commas.">
            <Input name="words_to_avoid" defaultValue={initial.words_to_avoid.join(", ")} />
          </Field>
        </div>

        <FormMessage>{state.error}</FormMessage>
        {state.saved && (
          <FormMessage kind="success">
            Saved. Claude will use this kit for everything it drafts from now on.
          </FormMessage>
        )}
        {canEdit ? (
          <SubmitButton pendingText="Saving…" className="sm:w-fit">
            Save brand kit
          </SubmitButton>
        ) : (
          <p className="text-muted-foreground text-sm">Only owners and admins can change these.</p>
        )}
      </fieldset>

      <aside aria-label="Preview" className="flex flex-col gap-3 lg:sticky lg:top-6 lg:self-start">
        <p className="text-xs font-semibold">How it will look</p>
        {preview ? (
          <>
            <div
              className="flex aspect-[4/5] flex-col justify-between rounded-lg p-5"
              style={{ background: preview[0].bg, color: preview[0].ink }}
            >
              <span className="text-xs font-semibold tracking-wide uppercase opacity-80">
                {name || "Your brand"}
              </span>
              <span
                className={cn(
                  "text-3xl leading-tight",
                  feel === "bold" ? "font-extrabold uppercase" : "font-semibold",
                )}
              >
                {tagline || "Made by hand, made for you"}
              </span>
              <span
                className="w-fit rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: preview[0].accent, color: preview[0].bg }}
              >
                New this week
              </span>
            </div>
            <ul className="grid grid-cols-5 gap-1.5">
              {preview.map((swatch, index) => (
                <li
                  key={index}
                  className="flex aspect-square items-center justify-center rounded-sm border text-sm font-semibold"
                  style={{ background: swatch.bg, color: swatch.ink }}
                >
                  Aa
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground text-xs">
              We pick the text colour for each background so it always stays readable.
            </p>
          </>
        ) : (
          <p className="text-muted-foreground text-sm">Add two colours to see a preview.</p>
        )}
      </aside>
    </form>
  );
}
