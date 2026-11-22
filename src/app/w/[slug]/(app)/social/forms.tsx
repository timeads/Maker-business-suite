"use client";

import { useActionState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import {
  draftTheMonth,
  saveLinkPage,
  savePlan,
  saveProject,
  updatePhoto,
  uploadPhotos,
  type SocialState,
} from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";
const file =
  "file:border-input text-sm file:mr-3 file:rounded-sm file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-semibold";

function Result({ state }: { state: SocialState }) {
  return (
    <>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </>
  );
}

type Option = { id: string; name: string };

export function UploadForm({
  slug,
  projects,
  projectId,
}: {
  slug: string;
  projects: Option[];
  /** When set, photos go straight into this project. */
  projectId?: string;
}) {
  const [state, action] = useActionState(uploadPhotos.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <input
        name="photos"
        type="file"
        multiple
        required
        accept="image/jpeg,image/png"
        aria-label="Photos to add"
        className={file}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="upload-tags">Tags for these</Label>
          <Input id="upload-tags" name="tags" placeholder="process, blue rug" />
        </div>
        {projectId ? (
          <input type="hidden" name="project" value={projectId} />
        ) : (
          projects.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="upload-project">Project</Label>
              <Select id="upload-project" name="project" defaultValue="">
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </Select>
            </div>
          )
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        JPEG or PNG, up to 5 MB each, 20 at a time. Separate tags with commas.
      </p>
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Adding…" className="sm:w-fit">
        Add photos
      </SubmitButton>
    </form>
  );
}

export function PhotoForm({
  slug,
  photo,
  projects,
}: {
  slug: string;
  photo: { id: string; title: string; tags: string[]; projectId: string | null; hidden: boolean };
  projects: Option[];
}) {
  const [state, action] = useActionState(updatePhoto.bind(null, slug, photo.id), {});
  const id = `ph-${photo.id}`;
  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor={`${id}-title`}>What it shows</Label>
      <Input id={`${id}-title`} name="title" maxLength={120} defaultValue={photo.title} />
      <Label htmlFor={`${id}-tags`}>Tags</Label>
      <Input id={`${id}-tags`} name="tags" defaultValue={photo.tags.join(", ")} />
      {projects.length > 0 && (
        <>
          <Label htmlFor={`${id}-project`}>Project</Label>
          <Select id={`${id}-project`} name="project" defaultValue={photo.projectId ?? ""}>
            <option value="">No project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </Select>
        </>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="hidden" defaultChecked={photo.hidden} />
        Put away (keeps it on posts that used it)
      </label>
      <Result state={state} />
      <SubmitButton variant="outline" size="sm" pendingText="Saving…" className="w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

export function ProjectForm({
  slug,
  project,
  topics,
}: {
  slug: string;
  project?: { id: string; name: string; note: string; topic: string | null; archived: boolean };
  topics: Option[];
}) {
  const [state, action] = useActionState(saveProject.bind(null, slug, project?.id ?? null), {});
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-name">Name</Label>
          <Input
            id="project-name"
            name="name"
            maxLength={80}
            defaultValue={project?.name}
            placeholder="Blue hallway runner"
            required
          />
        </div>
        {topics.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-topic">Usual topic</Label>
            <Select id="project-topic" name="topic" defaultValue={project?.topic ?? ""}>
              <option value="">None</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="project-note">About it</Label>
        <textarea
          id="project-note"
          name="note"
          rows={3}
          maxLength={2000}
          defaultValue={project?.note}
          placeholder="A commission for a narrow hallway. Hand-dyed wool, three weeks on the frame."
          className={textarea}
        />
      </div>
      {project && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="archived" defaultChecked={project.archived} />
          This one is finished: put it away
        </label>
      )}
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Saving…" className="sm:w-fit">
        {project ? "Save" : "Start project"}
      </SubmitButton>
    </form>
  );
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function PlanForm({
  slug,
  topics,
  slots,
  styleNotes,
}: {
  slug: string;
  topics: { id: string; name: string; about: string }[];
  slots: { weekday: number; time: string; topic: string | null }[];
  styleNotes: string;
}) {
  const [state, action] = useActionState(savePlan.bind(null, slug), {});
  // Existing times, plus three empty rows to add more.
  const rows = [...slots, ...Array.from({ length: 3 }, () => null)].slice(0, 21);
  return (
    <form action={action} className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="plan-topics">What you post about</Label>
        <textarea
          id="plan-topics"
          name="topics"
          rows={5}
          defaultValue={topics
            .map((topic) => (topic.about ? `${topic.name}: ${topic.about}` : topic.name))
            .join("\n")}
          placeholder={
            "In the studio: work in progress, the mess, the tools\nNew work: finished pieces, with size and price\nWorkshops: dates, what people made"
          }
          className={textarea}
        />
        <p className="text-muted-foreground text-xs">
          One per line. After a colon, say what that kind of post is like.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-xs leading-tight font-semibold">
          When you like to post each week
        </legend>
        {rows.map((slot, index) => (
          <div key={index} className="grid grid-cols-[1fr_7rem_1fr] gap-2">
            <Select
              name={`slot_day_${index}`}
              defaultValue={String(slot?.weekday ?? 1)}
              aria-label="Day"
            >
              {DAYS.map((day, weekday) => (
                <option key={day} value={weekday}>
                  {day}
                </option>
              ))}
            </Select>
            <Input
              name={`slot_time_${index}`}
              type="time"
              defaultValue={slot?.time ?? ""}
              aria-label="Time"
            />
            <Select
              name={`slot_topic_${index}`}
              defaultValue={slot?.topic ?? ""}
              aria-label="Topic"
            >
              <option value="">Anything</option>
              {topics.map((topic) => (
                <option key={topic.id} value={topic.id}>
                  {topic.name}
                </option>
              ))}
            </Select>
          </div>
        ))}
        <p className="text-muted-foreground text-xs">
          Clear a time to remove that row. Save to get more empty rows. New topics appear in these
          lists after you save.
        </p>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="plan-style">How you sound</Label>
        <textarea
          id="plan-style"
          name="style_notes"
          rows={5}
          maxLength={3000}
          defaultValue={styleNotes}
          placeholder="Short sentences. Never 'excited to announce'. One emoji at most. Always say the size of a rug. Hashtags at the end, five or fewer."
          className={textarea}
        />
        <p className="text-muted-foreground text-xs">
          Claude reads this before every draft. Add to it whenever a draft sounds wrong.
        </p>
      </div>
      <Result state={state} />
      <SubmitButton pendingText="Saving…" className="sm:w-fit">
        Save plan
      </SubmitButton>
    </form>
  );
}

export function DraftMonthForm({ slug, open }: { slug: string; open: number }) {
  const [state, action] = useActionState(draftTheMonth.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <Result state={state} />
      <SubmitButton variant="outline" pendingText="Writing drafts… this takes a minute">
        Draft {Math.min(open, 10)} of them with Claude
      </SubmitButton>
      <p className="text-muted-foreground text-xs">
        Each one is saved as a draft, pencilled in for its time. Nothing is posted until you read it
        and schedule it yourself.
      </p>
    </form>
  );
}

export function LinkPageForm({
  slug,
  page,
  linksText,
  canEdit,
}: {
  slug: string;
  page: { published: boolean; heading: string; intro: string; show_posts: boolean };
  linksText: string;
  canEdit: boolean;
}) {
  const [state, action] = useActionState(saveLinkPage.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-4">
      <fieldset disabled={!canEdit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="links-heading">Heading</Label>
          <Input
            id="links-heading"
            name="heading"
            maxLength={80}
            defaultValue={page.heading}
            placeholder="Leave empty to use your business name"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="links-intro">A line about you</Label>
          <Input id="links-intro" name="intro" maxLength={300} defaultValue={page.intro} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="links-list">Links</Label>
          <textarea
            id="links-list"
            name="links"
            rows={7}
            defaultValue={linksText}
            placeholder={
              "Shop the rugs | https://yourshop.com\nBook a workshop | https://yourshop.com/workshops\nNewsletter | https://yourshop.com/news"
            }
            className={textarea}
          />
          <p className="text-muted-foreground text-xs">
            One per line: what the button says, a bar, then the address. Top one first.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="show_posts" defaultChecked={page.show_posts} />
          Show my latest posted photos under the links
        </label>
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" name="published" defaultChecked={page.published} />
          Publish this page
        </label>
      </fieldset>
      <Result state={state} />
      {canEdit ? (
        <SubmitButton pendingText="Saving…" className="sm:w-fit">
          Save link page
        </SubmitButton>
      ) : (
        <p className="text-muted-foreground text-sm">An owner or admin can change this page.</p>
      )}
    </form>
  );
}
