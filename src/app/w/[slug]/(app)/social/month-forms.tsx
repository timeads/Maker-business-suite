"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  runMonthNow,
  saveReviewDays,
  saveStyleNotes,
  suggestNotesFromEdits,
  type MonthState,
} from "./month-actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

const WEEKS = ["First", "Second", "Third", "Fourth"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Result({ state }: { state: MonthState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

export type ReviewDayRow = {
  brandId: string;
  brandName: string;
  week: number | null;
  weekday: number;
  leadDays: number;
  auto: boolean;
};

/** Each brand's review day, and whether its month drafts itself. Owners and admins. */
export function ReviewDaysForm({ slug, rows }: { slug: string; rows: ReviewDayRow[] }) {
  const [state, action] = useActionState(saveReviewDays.bind(null, slug), {});
  const many = rows.length > 1;
  return (
    <form action={action} className="flex flex-col gap-4">
      {rows.map((row) => (
        <fieldset key={row.brandId} className="flex flex-col gap-2">
          {many && (
            <legend className="pb-1 text-xs leading-tight font-semibold">{row.brandName}</legend>
          )}
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_9rem]">
            <Select
              name={`week_${row.brandId}`}
              defaultValue={row.week ? String(row.week) : ""}
              aria-label="Which week"
            >
              <option value="">No review day</option>
              {WEEKS.map((week, index) => (
                <option key={week} value={index + 1}>
                  {week}
                </option>
              ))}
            </Select>
            <Select
              name={`weekday_${row.brandId}`}
              defaultValue={String(row.weekday)}
              aria-label="Day of the week"
            >
              {DAYS.map((day, index) => (
                <option key={day} value={index}>
                  {day}
                </option>
              ))}
            </Select>
            <div className="flex items-center gap-2">
              <Input
                name={`lead_${row.brandId}`}
                type="number"
                min={0}
                max={21}
                defaultValue={row.leadDays}
                aria-label="Days ahead"
                className="w-16"
              />
              <span className="text-muted-foreground text-xs">days ahead</span>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name={`auto_${row.brandId}`} defaultChecked={row.auto} />
            Draft the month by itself, ready for review
          </label>
        </fieldset>
      ))}
      <p className="text-muted-foreground text-xs">
        Once a month, that many days before your review day (0 means on the day), Claude drafts the
        month from that review day to the next one: a post for each open time, and carousels from
        your projects&apos; unposted photos. They wait in Review. Nothing is scheduled or posted
        until someone approves it.
      </p>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        Save review days
      </SubmitButton>
    </form>
  );
}

/** "Run it now" for one brand's coming month. */
export function RunNowForm({
  slug,
  brands,
}: {
  slug: string;
  brands: { id: string; name: string }[];
}) {
  const [state, action] = useActionState(runMonthNow.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {brands.length > 1 && (
          <select
            name="brand_id"
            aria-label="Brand"
            className="border-input bg-card h-8 rounded-sm border px-2 text-sm"
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        )}
        {brands.length === 1 && <input type="hidden" name="brand_id" value={brands[0].id} />}
        <SubmitButton variant="outline" pendingText="Starting…">
          Run it now
        </SubmitButton>
      </div>
      <Result state={state} />
    </form>
  );
}

/**
 * A brand's style notes. "Suggest notes from my edits" only fills the box;
 * the notes are kept when a person presses Save.
 */
export function StyleNotesForm({
  slug,
  brandId,
  notes,
  canSuggest,
}: {
  slug: string;
  brandId: string;
  notes: string;
  canSuggest: boolean;
}) {
  const [text, setText] = useState(notes);
  const [saved, save] = useActionState(saveStyleNotes.bind(null, slug), {});
  const [suggested, suggest] = useActionState(suggestNotesFromEdits.bind(null, slug), {});
  // A new suggestion fills the box (adjusting state while rendering, as React suggests).
  const [seen, setSeen] = useState(suggested);
  if (suggested !== seen) {
    setSeen(suggested);
    if (suggested.notes !== undefined) setText(suggested.notes);
  }
  return (
    <div className="flex flex-col gap-3">
      <form id="style-notes" action={save} className="flex flex-col gap-3">
        <input type="hidden" name="brand_id" value={brandId} />
        <Label htmlFor="style-notes-text">Style notes</Label>
        <textarea
          id="style-notes-text"
          name="notes"
          rows={10}
          maxLength={4000}
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={
            "- Open with the piece itself, not a greeting\n- Say the size of a rug when we know it\n- Three hashtags at most, at the end"
          }
          className={textarea}
        />
        <p className="text-muted-foreground text-xs">
          One note per line. Claude reads these before every draft for this brand.
        </p>
        <Result state={saved} />
      </form>
      <Result state={suggested} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton form="style-notes" pendingText="Saving…">
          Save notes
        </SubmitButton>
        {canSuggest && (
          <form action={suggest}>
            <input type="hidden" name="brand_id" value={brandId} />
            <input type="hidden" name="notes" value={text} />
            <SubmitButton variant="outline" pendingText="Reading your edits…">
              Suggest notes from my edits
            </SubmitButton>
          </form>
        )}
      </div>
    </div>
  );
}
