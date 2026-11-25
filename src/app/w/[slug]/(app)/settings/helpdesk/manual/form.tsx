"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { MAX_MONTHLY_CAP, type ManualConfig } from "@/lib/helpdesk/manual/config";
import { saveManualSettings } from "../../../helpdesk/manual/actions";

const area =
  "border-input bg-card focus-visible:border-ochre focus-visible:ring-ochre/25 w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";
const hint = "text-muted-foreground font-read text-xs";
const group = "flex flex-col gap-3 border-border border-t pt-5 first:border-t-0 first:pt-0";
const legend = "text-sm font-bold";

export function ManualSettingsForm({
  slug,
  config,
  folders,
  views,
  knownTags,
}: {
  slug: string;
  config: ManualConfig;
  folders: { id: string; name: string }[];
  views: { id: string; name: string }[];
  knownTags: string[];
}) {
  const [state, action] = useActionState(saveManualSettings.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-5">
      <fieldset className={group}>
        <legend className={legend}>What it&apos;s called</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-name">Name</Label>
            <Input id="manual-name" name="name" maxLength={40} defaultValue={config.name} />
            <p className={hint}>On the help desk&apos;s menu and at the top of the page.</p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-topics">Name of the first tab</Label>
            <Input
              id="manual-topics"
              name="topics_label"
              maxLength={30}
              defaultValue={config.topics_label}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="manual-about">What belongs in it</Label>
          <textarea
            id="manual-about"
            name="about"
            rows={2}
            maxLength={300}
            defaultValue={config.about}
            placeholder="How we work out what's wrong with the things we make, and how we put it right."
            className={area}
          />
          <p className={hint}>
            A sentence in your own words. Claude is told this, so it knows which conversations are
            worth writing down.
          </p>
        </div>
      </fieldset>

      <fieldset className={group}>
        <legend className={legend}>How topics are sorted and written</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-facets">Labels to sort topics by</Label>
            <textarea
              id="manual-facets"
              name="facets"
              rows={4}
              defaultValue={config.facets.map((f) => f.label).join("\n")}
              className={area}
            />
            <p className={hint}>
              One a line, up to four. The first one groups the list. Reword one in place and topics
              keep what they have under it.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-sections">Headings of a topic</Label>
            <textarea
              id="manual-sections"
              name="sections"
              rows={6}
              defaultValue={config.sections.join("\n")}
              className={area}
            />
            <p className={hint}>One a line, in the order a topic should read. Up to eight.</p>
          </div>
        </div>
      </fieldset>

      <fieldset className={group}>
        <legend className={legend}>Which conversations it learns from</legend>
        <p className={hint}>
          A conversation is read once it is closed and the team has answered it. Tick any of these;
          one that matches any of them counts. With none chosen, nothing is read.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">Folders</span>
            {folders.length === 0 && <p className={hint}>No folders yet.</p>}
            {folders.map((folder) => (
              <label key={folder.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="folder"
                  value={folder.id}
                  defaultChecked={config.sources.folders.includes(folder.id)}
                />
                {folder.name}
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold">Saved views</span>
            {views.length === 0 && <p className={hint}>No saved views yet.</p>}
            {views.map((view) => (
              <label key={view.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="view"
                  value={view.id}
                  defaultChecked={config.sources.views.includes(view.id)}
                />
                {view.name}
              </label>
            ))}
            {views.length > 0 && (
              <p className={hint}>
                A view&apos;s tags, folder, priority and words are used; “open”, “mine” and “unread”
                are not.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-tags">Tags</Label>
            <Input
              id="manual-tags"
              name="tags"
              defaultValue={config.sources.tags.join(", ")}
              placeholder="with commas between"
              list="manual-known-tags"
            />
            <datalist id="manual-known-tags">
              {knownTags.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
            {knownTags.length > 0 && (
              <p className={hint}>In use now: {knownTags.slice(0, 12).join(", ")}</p>
            )}
          </div>
        </div>
      </fieldset>

      <fieldset className={group}>
        <legend className={legend}>When it runs, and how much</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="auto"
            value="1"
            defaultChecked={config.auto}
            className="mt-0.5"
          />
          <span>
            Bring it up to date by itself
            <span className={`${hint} block`}>
              Off, it only reads when an owner or admin presses “Update now”.
            </span>
          </span>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-every">How often</Label>
            <Select id="manual-every" name="every" defaultValue={config.every}>
              <option value="day">Once a day</option>
              <option value="week">Once a week</option>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="manual-cap">Most conversations read in a month</Label>
            <Input
              id="manual-cap"
              name="monthly_cap"
              type="number"
              min={0}
              max={MAX_MONTHLY_CAP}
              defaultValue={config.monthly_cap}
            />
            <p className={hint}>
              Each one read counts against the plan&apos;s AI allowance. At the limit, or when the
              allowance runs out, it stops and says so.
            </p>
          </div>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="read_photos"
            value="1"
            defaultChecked={config.read_photos}
            className="mt-0.5"
          />
          <span>
            Show Claude the customer&apos;s photos
            <span className={`${hint} block`}>
              Up to three pictures a conversation. Videos and other files are only named.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="use_in_drafts"
            value="1"
            defaultChecked={config.use_in_drafts}
            className="mt-0.5"
          />
          <span>
            Let reply drafts lean on published topics
            <span className={`${hint} block`}>
              When someone presses “AI” in the reply box, the few topics that match the conversation
              are handed over as reference. A draft is never sent by itself.
            </span>
          </span>
        </label>
      </fieldset>

      {state.error && <FormMessage>{state.error}</FormMessage>}
      {state.message && <FormMessage kind="success">{state.message}</FormMessage>}
      <div>
        <SubmitButton pendingText="Saving…">Save</SubmitButton>
      </div>
    </form>
  );
}
