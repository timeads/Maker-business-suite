"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Label } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { ReviewSettings } from "@/lib/social/review";
import { approvePosts, saveReviewSettings, sendBackPost } from "./actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

/** An approver's "Send back", with the note that says what to change. */
export function SendBackForm({ slug, postId }: { slug: string; postId: string }) {
  const [state, action] = useActionState(sendBackPost.bind(null, slug, postId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <Label htmlFor="note">What should change?</Label>
      <textarea
        id="note"
        name="note"
        rows={3}
        maxLength={1000}
        required
        placeholder="e.g. Swap the second photo for one with the finished rug"
        className={textarea}
      />
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="outline" pendingText="Sending back…" className="w-fit">
        Send it back
      </SubmitButton>
    </form>
  );
}

export type QueuePost = {
  id: string;
  snippet: string;
  when: string | null;
  photo: string | null;
  by: string | null;
  /** Has slides that are drawn into pictures when it is approved. */
  slides?: boolean;
};
export type QueueMonth = { month: string | null; label: string; posts: QueuePost[] };

/**
 * The posts waiting for review, by the month they are pencilled in for. An approver can tick
 * some and approve them, or approve a whole month: either way it is one press, checked by the
 * database, and each post goes out at the time it was pencilled in for.
 */
export function ReviewQueue({
  slug,
  months,
  canApprove,
  prepare,
}: {
  slug: string;
  months: QueueMonth[];
  canApprove: boolean;
  /**
   * Anything to do in this browser before posts can be approved (drawing slides into pictures).
   * Returns the ids it couldn't get ready, with why.
   */
  prepare?: (ids: string[]) => Promise<{ id: string; reason: string }[]>;
}) {
  const router = useRouter();
  const [ticked, setTicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    ok?: string;
    problems: { id: string; reason: string }[];
  }>({
    problems: [],
  });
  const titleOf = new Map(months.flatMap((m) => m.posts.map((p) => [p.id, p.snippet] as const)));

  const approve = async (ids: string[], month: string | null) => {
    setBusy(true);
    setMessage({ problems: [] });
    try {
      const wanted = month
        ? (months.find((m) => m.month === month)?.posts.map((p) => p.id) ?? [])
        : ids;
      const unready = prepare ? await prepare(wanted) : [];
      const ready = wanted.filter((id) => !unready.some((u) => u.id === id));
      // A month is approved by its ids once some needed getting ready, so a post that
      // couldn't be drawn isn't approved with stale pictures.
      const result =
        ready.length === 0 ? { approved: 0, skipped: [] } : await approvePosts(slug, ready, null);
      if (result.error) {
        setMessage({ problems: [{ id: "", reason: result.error }] });
        return;
      }
      const n = result.approved ?? 0;
      setMessage({
        ok:
          n > 0
            ? `${n} post${n === 1 ? "" : "s"} approved and scheduled.`
            : unready.length || result.skipped?.length
              ? undefined
              : "Nothing to approve.",
        problems: [...unready, ...(result.skipped ?? [])],
      });
      setTicked([]);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      {message.ok && <FormMessage kind="success">{message.ok}</FormMessage>}
      {message.problems.length > 0 && (
        <FormMessage>
          {message.problems.length === 1 && !message.problems[0].id
            ? message.problems[0].reason
            : `${message.problems.length} couldn't be approved: ${message.problems
                .map((p) => `“${titleOf.get(p.id) ?? "a post"}”: ${p.reason}`)
                .join(" ")}`}
        </FormMessage>
      )}
      {canApprove && ticked.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" onClick={() => void approve(ticked, null)} disabled={busy}>
            {busy ? "Approving…" : `Approve ${ticked.length} ticked`}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setTicked([])} disabled={busy}>
            Untick all
          </Button>
        </div>
      )}
      {months.map((group) => (
        <section key={group.label} className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{group.label}</h2>
            {canApprove && group.month && ticked.length === 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => void approve([], group.month)}
              >
                {busy ? "Approving…" : `Approve all ${group.posts.length} for ${group.label}`}
              </Button>
            )}
          </div>
          <ul className="divide-border border-border bg-card flex flex-col divide-y rounded-md border">
            {group.posts.map((post) => (
              <li key={post.id} className="flex items-center gap-3 px-3 py-2">
                {canApprove && (
                  <input
                    type="checkbox"
                    aria-label={`Tick “${post.snippet}”`}
                    checked={ticked.includes(post.id)}
                    onChange={(event) =>
                      setTicked((now) =>
                        event.target.checked
                          ? [...now, post.id]
                          : now.filter((id) => id !== post.id),
                      )
                    }
                  />
                )}
                {post.photo ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
                  <img
                    src={post.photo}
                    alt=""
                    className="border-border size-12 shrink-0 rounded-sm border object-cover"
                  />
                ) : (
                  <span className="bg-muted size-12 shrink-0 rounded-sm" aria-hidden />
                )}
                <Link
                  href={`/w/${slug}/social/${post.id}`}
                  className="flex min-w-0 flex-1 flex-col hover:underline"
                >
                  <span className="font-read truncate text-sm">{post.snippet}</span>
                  <span className="text-muted-foreground text-xs">
                    {post.when ?? "No time yet"}
                    {post.by ? ` · from ${post.by}` : ""}
                  </span>
                </Link>
                {post.slides && <Badge tone="open">Slides</Badge>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Settings → Social & emails → Post review. */
export function ReviewSettingsForm({ slug, settings }: { slug: string; settings: ReviewSettings }) {
  const [state, action] = useActionState(saveReviewSettings.bind(null, slug), {});
  return (
    <form action={action} className="flex flex-col gap-5">
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="require_approval"
          defaultChecked={settings.require_approval}
          className="mt-1"
        />
        <span>
          <span className="font-semibold">Approve posts before they go out</span>
          <span className="text-muted-foreground block text-xs">
            On: only the people below can schedule a post; everyone else sends it for review. Off:
            anyone who can write can schedule, and review is there when you want a second look.
          </span>
        </span>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="pb-2 text-xs leading-tight font-semibold">Who can approve</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked disabled /> Owners (always)
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="approvers"
            value="admin"
            defaultChecked={settings.approvers.includes("admin")}
          />
          Admins
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="approvers"
            value="member"
            defaultChecked={settings.approvers.includes("member")}
          />
          Members
        </label>
      </fieldset>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
      <SubmitButton pendingText="Saving…" className="w-fit">
        Save
      </SubmitButton>
    </form>
  );
}
