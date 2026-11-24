"use client";

import { useActionState } from "react";
import { Input, Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { saveSeason } from "./actions";
import { Result } from "./forms";

export type SeasonValues = {
  id: string;
  name: string;
  in_stock_by: string;
  lift_pct: number;
  note: string;
};

/** Adds a selling season, or changes one. A new season's form clears itself once saved. */
export function SeasonForm({ slug, season }: { slug: string; season?: SeasonValues }) {
  const [state, action] = useActionState(saveSeason.bind(null, slug, season?.id ?? null), {});
  const id = `season-${season?.id ?? "new"}`;
  return (
    <form action={action} className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-name`}>Season</Label>
          <Input
            id={`${id}-name`}
            name="name"
            maxLength={80}
            defaultValue={season?.name}
            placeholder="Holiday rush"
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-day`}>In stock by</Label>
          <Input
            id={`${id}-day`}
            name="in_stock_by"
            type="date"
            defaultValue={season?.in_stock_by}
            required
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-lift`}>Extra lift, %</Label>
          <Input
            id={`${id}-lift`}
            name="lift_pct"
            type="number"
            min={0}
            max={500}
            step={1}
            defaultValue={season?.lift_pct || ""}
            placeholder="0"
            className="w-24"
          />
        </div>
        <div className="flex min-w-40 flex-1 flex-col gap-1.5">
          <Label htmlFor={`${id}-note`}>Note</Label>
          <Input
            id={`${id}-note`}
            name="note"
            maxLength={300}
            defaultValue={season?.note}
            placeholder="Optional"
          />
        </div>
        <SubmitButton variant="outline" pendingText="Saving…">
          {season ? "Save" : "Add season"}
        </SubmitButton>
      </div>
      <Result state={state} />
    </form>
  );
}
