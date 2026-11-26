"use client";

import Link from "next/link";
import { startTransition, useActionState, useEffect, useRef, useState } from "react";
import { DesignDialog } from "@/components/slides/DesignDialog";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Label, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import { starterDesignFor } from "@/lib/brand/slides";
import type { BrandKit } from "@/lib/design/brands";
import type { SlideDesign } from "@/lib/design/slide-design";
import { renderSlideBlob } from "@/lib/design/slide-render";
import {
  NETWORK_LABELS,
  checkPlace,
  placesOf,
  problemWords,
  type Place,
} from "@/lib/social/networks";
import {
  PRIVACY_LABELS,
  checkTikTokOptions,
  privacyChoices,
  tiktokOptionsFor,
  type CreatorChoices,
  type TikTokOptions,
} from "@/lib/social/tiktok-options";
import { cn } from "@/lib/utils";
import {
  deletePost,
  draftPostCaption,
  listDesignPhotos,
  loadAssetDesign,
  retryPost,
  savePost,
  settleTarget,
  type SocialState,
} from "./actions";
import { designTitle, saveDesignAsPictures } from "./designed";
import { getReadyToSend } from "./send-prep";
import type { ComposerAccount } from "./shared";
import { loadTikTokChoices } from "./tiktok-actions";

const textarea =
  "border-input bg-card placeholder:text-muted-foreground focus-visible:border-ochre focus-visible:ring-ochre/25 font-read w-full rounded-sm border px-[11px] py-2 text-sm outline-none focus-visible:ring-2";

export type LibraryPhoto = {
  id: string;
  url: string;
  title: string;
  video?: boolean;
  /** Made in the designer, so it can be opened and changed. */
  designed?: boolean;
};

/** Where the post is in review, and what this person may do about it. */
export type ComposerReview = {
  /** May schedule straight away (approval isn't required, or they approve). */
  canSchedule: boolean;
  /** May approve: their Schedule press is the approval. */
  canApprove: boolean;
  /** Whether this workspace requires approval at all. */
  required: boolean;
  state: "waiting" | "sent_back" | null;
};

export type ComposerPost = {
  id: string;
  caption: string;
  /** A caption of its own, by account id (or, from before accounts, by place). */
  captions: Record<string, string>;
  channels: string[];
  /** The accounts it goes to. */
  accountIds: string[];
  photoIds: string[];
  projectId: string | null;
  topic: string | null;
  aiDraft: string | null;
  planned: boolean;
  day: string;
  time: string;
  /** The carousel's slides, kept as one design until the post is approved. */
  slides?: SlideDesign | null;
  /** Approved or scheduled: the slides were drawn and are fixed now. */
  slidesFixed?: boolean;
  /** Each account's own choices for its network (TikTok's), by account id. */
  targetOptions?: Record<string, unknown>;
};

export function Composer({
  slug,
  post,
  defaults,
  timezone,
  brands,
  brand,
  accounts,
  library,
  projects,
  topics,
  kit,
  photoNotes = {},
  review = { canSchedule: true, canApprove: false, required: false, state: null },
}: {
  slug: string;
  post?: ComposerPost;
  defaults: { day: string; time: string; topic?: string | null; projectId?: string | null };
  timezone: string;
  /** The brands a post can be drawn in (more than one: the composer asks which). */
  brands: { id: string; name: string }[];
  /** The brand picked: its kit draws the slides and its voice drafts the caption. */
  brand: { id: string; name: string } | null;
  /** That brand's accounts in use. */
  accounts: ComposerAccount[];
  /** Recent photos to pick from, plus any already on the post. */
  library: LibraryPhoto[];
  projects: { id: string; name: string }[];
  topics: { id: string; name: string }[];
  /** The workspace's kit for the designer, or null until a brand kit is set up. */
  kit: BrandKit | null;
  /** Why a photo already on a drafted post was picked, by photo. */
  photoNotes?: Record<string, string>;
  review?: ComposerReview;
}) {
  const [state, save] = useActionState(savePost.bind(null, slug, post?.id ?? null), {});
  const [caption, setCaption] = useState(post?.caption ?? "");
  const [aiDraft, setAiDraft] = useState(post?.aiDraft ?? "");
  const [picked, setPicked] = useState<string[]>(post?.photoIds ?? []);
  // A caption of its own per account; one from before accounts was by place.
  const ownWords = (account: ComposerAccount) =>
    post?.captions[account.id] ?? post?.captions[account.network];
  const [own, setOwn] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(accounts.map((account) => [account.id, Boolean(ownWords(account))])),
  );
  const [ownCaptions, setOwnCaptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(accounts.map((account) => [account.id, ownWords(account) ?? ""])),
  );
  const startTicked = (account: ComposerAccount) =>
    post?.accountIds.length
      ? post.accountIds.includes(account.id)
      : post?.channels.length
        ? post.channels.some((c) => placesOf(account.network).includes(c as Place))
        : // A new post starts on the brand's Facebook and Instagram, as it always did;
          // TikTok and LinkedIn are ticked by choice.
          account.canPost && (account.network === "facebook" || account.network === "instagram");
  const [ticked, setTicked] = useState<string[]>(() =>
    accounts.filter((account) => account.canPost && startTicked(account)).map((a) => a.id),
  );
  const [feed, setFeed] = useState(
    post?.channels.length ? post.channels.includes("instagram") : true,
  );
  const [story, setStory] = useState(post?.channels.includes("instagram_story") ?? false);
  // TikTok's choices, per TikTok account, and what TikTok says each may choose.
  const [tiktok, setTiktok] = useState<Record<string, TikTokOptions & { disclose: boolean }>>(() =>
    Object.fromEntries(
      accounts
        .filter((account) => account.network === "tiktok")
        .map((account) => {
          const options = tiktokOptionsFor(post?.targetOptions ?? {}, account.id);
          return [
            account.id,
            { ...options, disclose: options.brand_organic || options.brand_content },
          ];
        }),
    ),
  );
  const [creators, setCreators] = useState<
    Record<string, { choices: CreatorChoices | null; audited: boolean; error?: string }>
  >({});
  // Photos that arrived after the page was drawn: ones just designed, or matched to a draft.
  const [extra, setExtra] = useState<LibraryPhoto[]>([]);
  // Why a photo was put on the post without being asked for, by photo.
  const [notes, setNotes] = useState<Record<string, string>>(photoNotes);
  // A photo that fits the draft, offered when the post already has photos of its own.
  const [offer, setOffer] = useState<(LibraryPhoto & { reason: string }) | null>(null);
  // The designer, open on a new design or on one being changed.
  const [designing, setDesigning] = useState<{
    design: SlideDesign;
    replaces: string | null;
    /** "slides": the post's own carousel, kept as one design. */
    mode: "slides" | "picture";
  } | null>(null);
  const [slides, setSlides] = useState<SlideDesign | null>(post?.slides ?? null);
  const [slidesChanged, setSlidesChanged] = useState(false);
  const [preparing, setPreparing] = useState("");
  const [prepError, setPrepError] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [designNote, setDesignNote] = useState("");
  const captionRef = useRef<HTMLTextAreaElement>(null);
  const [draftState, draft, drafting] = useActionState<SocialState, FormData>(
    async (prev, formData) => {
      const result = await draftPostCaption(slug, prev, formData);
      if (result.draft) {
        setCaption(result.draft);
        setAiDraft(result.draft);
        captionRef.current?.focus();
      }
      const match = result.photo;
      if (match && !picked.includes(match.id)) {
        const photo = { id: match.id, url: match.url, title: match.title };
        setExtra((now) => (now.some((x) => x.id === photo.id) ? now : [...now, photo]));
        if (picked.length === 0) {
          // One photo at most is added by itself, and only to a post that has none.
          setPicked([match.id]);
          setNotes((now) => ({ ...now, [match.id]: match.reason }));
          setOffer(null);
        } else {
          setOffer({ ...photo, reason: match.reason });
        }
      }
      return result;
    },
    {},
  );
  const connected = accounts.some((account) => account.canPost);
  const byId = new Map([...library, ...extra].map((photo) => [photo.id, photo]));
  // A video goes out on its own, so picking one replaces what was picked,
  // and picking a photo afterwards replaces the video.
  const toggle = (id: string) =>
    setPicked((now) => {
      if (now.includes(id)) return now.filter((x) => x !== id);
      if (byId.get(id)?.video || now.some((x) => byId.get(x)?.video)) return [id];
      return now.length < 10 ? [...now, id] : now;
    });
  const hasVideo = picked.some((id) => byId.get(id)?.video);
  const photoCount =
    picked.filter((id) => !byId.get(id)?.video).length + (slides?.slides.length ?? 0);
  const tickedAccounts = accounts.filter((account) => ticked.includes(account.id));
  const instagramAccounts = accounts.filter((account) => account.network === "instagram");
  const tiktokTicked = tickedAccounts.filter((account) => account.network === "tiktok");
  // Each ticked account's network rules, and TikTok's choices, before anything is scheduled.
  // The database checks the same rules again.
  const problems = [
    ...new Set([
      ...tickedAccounts.flatMap((account) =>
        placesOf(account.network)
          .filter(
            (place) =>
              account.network !== "instagram" ||
              (place === "instagram" ? feed : place === "instagram_story" ? story : false),
          )
          .flatMap((place) =>
            checkPlace(place, {
              words: own[account.id] ? ownCaptions[account.id] || caption : caption,
              photos: photoCount,
              video: Boolean(hasVideo),
            }).map(problemWords),
          ),
      ),
      ...tiktokTicked.flatMap((account) => {
        const creator = creators[account.id];
        const problem = checkTikTokOptions(
          tiktok[account.id],
          creator?.choices ?? null,
          creator?.audited ?? false,
        );
        return problem ? [`${account.label}: ${problem}`] : [];
      }),
    ]),
  ];
  const firstPhoto = picked.map((id) => byId.get(id)).find((photo) => photo && !photo.video);

  const slidesFixed = Boolean(post?.slidesFixed);
  const openDesigner = (photo?: string) => {
    if (!kit) return;
    setDesignNote("");
    setDesigning({
      design: slides ?? starterDesignFor(kit, { photo }),
      replaces: null,
      mode: "slides",
    });
  };
  const keepSlides = async (design: SlideDesign) => {
    const others = picked.filter((id) => !byId.get(id)?.video);
    if (others.length + design.slides.length > 10) {
      throw new Error("A post can have up to 10 photos, slides included. Take some off first.");
    }
    if (picked.some((id) => byId.get(id)?.video)) setPicked(others);
    setSlides(design);
    setSlidesChanged(true);
    setDesigning(null);
    setDesignNote(
      "Your slides are kept on this post as one design. They're made into pictures when the post is approved or scheduled. Save the post to keep them.",
    );
  };

  /**
   * Schedule, Post now and Approve on a post with slides: save it as a draft, draw the slides
   * here, then let the same press schedule it. If drawing fails it stays a draft, with why.
   */
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const intent = submitter?.value ?? "draft";
    if (intent !== "schedule" && intent !== "now") return;
    if (problems.length > 0) {
      event.preventDefault();
      setPrepError(problems.join(" "));
      return;
    }
    // Slides are drawn and Instagram's photos sized in this browser first.
    const data = new FormData(event.currentTarget);
    const toInstagram =
      data.get("channel_instagram") === "on" || data.get("channel_instagram_story") === "on";
    const newFiles = data.getAll("photos").some((file) => file instanceof File && file.size > 0);
    if (!slides && !(toInstagram && (picked.length > 0 || newFiles))) return;
    event.preventDefault();
    const form = event.currentTarget;
    void (async () => {
      setPrepError("");
      setPreparing("Saving…");
      try {
        const first = new FormData(form, submitter);
        first.set("intent", "prepare");
        const saved = await savePost(slug, post?.id ?? null, {}, first);
        if (saved.error || !saved.postId) {
          setPrepError(saved.error ?? "That didn't save. Please try again.");
          return;
        }
        setPreparing(slides ? "Making the slides into pictures…" : "Getting the photos ready…");
        const ready = await getReadyToSend(slug, saved.postId, kit);
        if (ready.error) {
          setPrepError(
            `${ready.error} The post is saved as a draft and hasn't been ${intent === "now" ? "sent" : "scheduled"}.`,
          );
          return;
        }
        setPreparing("Scheduling…");
        const second = new FormData(form, submitter);
        second.set("post_id", saved.postId);
        second.set("slides_changed", "0");
        second.delete("photos");
        second.delete("asset");
        for (const id of saved.assetIds ?? []) second.append("asset", id);
        startTransition(() => save(second));
      } finally {
        setPreparing("");
      }
    })();
  };
  const editDesign = async (id: string) => {
    setDesignNote("");
    const found = await loadAssetDesign(slug, id);
    if ("error" in found) return setDesignNote(found.error);
    setDesigning({ design: found.design, replaces: id, mode: "picture" });
  };
  /** Draws the pictures, keeps them in the assets and puts them on the post, in order. */
  const saveDesign = async (design: SlideDesign) => {
    if (!kit || !designing) return;
    if (designing.mode === "slides") return keepSlides(design);
    const replaces = designing.replaces;
    const others = picked.filter((id) => !byId.get(id)?.video && id !== replaces);
    if (others.length + design.slides.length > 10) {
      throw new Error("A post can have up to 10 photos. Take some off first, then save again.");
    }
    const pictures = await saveDesignAsPictures(slug, design, kit, {
      jpeg: true,
      title: designTitle(design, "Designed picture"),
      replaces,
    });
    const made = pictures.map((picture) => ({ ...picture, designed: true }));
    setExtra((now) => [...now, ...made]);
    setPicked((now) => {
      const ids = made.map((picture) => picture.id);
      // A changed design takes the old picture's place; new ones go on the end. A video steps aside.
      const photos = now.filter((id) => !byId.get(id)?.video);
      return replaces && photos.includes(replaces)
        ? photos.flatMap((id) => (id === replaces ? ids : [id]))
        : [...photos, ...ids];
    });
    setDesigning(null);
    setDesignNote(
      replaces
        ? "The new picture is on this post and in your assets. Save the post to keep it."
        : `${made.length === 1 ? "Your picture is" : `Your ${made.length} pictures are`} on this post and in your assets. Save the post to keep ${made.length === 1 ? "it" : "them"}.`,
    );
  };
  const move = (id: string, by: number) =>
    setPicked((now) => {
      const from = now.indexOf(id);
      const to = from + by;
      if (from < 0 || to < 0 || to >= now.length) return now;
      const next = [...now];
      [next[from], next[to]] = [next[to], next[from]];
      return next;
    });

  return (
    <>
      {/* Outside the form, so nothing typed in the designer can submit the post. */}
      {designing && kit && (
        <DesignDialog
          initial={designing.design}
          kit={kit}
          loadPhotos={() => listDesignPhotos(slug)}
          title={
            designing.replaces ? "Edit this design" : slides ? "Edit the slides" : "Design slides"
          }
          description={
            designing.mode === "slides"
              ? "Click any text to change it, drag to move it, or change the layout, colour and photos. The slides stay one design on this post until it's approved; that's when they become pictures."
              : "Click any text to change it, drag to move it, or change the layout, colour and photos. The pictures are made when you save."
          }
          saveLabel={
            designing.replaces
              ? "Save the new picture"
              : designing.mode === "slides"
                ? "Keep these slides"
                : "Save to this post"
          }
          single={Boolean(designing.replaces)}
          onClose={() => setDesigning(null)}
          onSave={saveDesign}
        />
      )}
      <form ref={formRef} action={save} onSubmit={submit} className="flex flex-col gap-6">
        <input type="hidden" name="ai_draft" value={aiDraft} />
        {brand && <input type="hidden" name="brand_id" value={brand.id} />}
        {brands.length > 1 && (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-semibold">Brand</span>
            <div className="flex flex-wrap gap-2" role="list">
              {brands.map((each) => (
                <Link
                  key={each.id}
                  role="listitem"
                  href={`?brand=${each.id}`}
                  aria-current={each.id === brand?.id ? "true" : undefined}
                  className={cn(
                    "rounded-full border px-3 py-1 text-sm",
                    each.id === brand?.id
                      ? "border-teal bg-teal-soft text-teal-soft-ink font-semibold"
                      : "border-input hover:bg-hover",
                  )}
                >
                  {each.name}
                </Link>
              ))}
            </div>
            <p className="text-muted-foreground text-xs">
              Pick the brand first: it sets the look of the slides, the voice of Claude&apos;s draft
              and the accounts below. Changing it starts the page again, so save anything you have
              written first.
            </p>
          </div>
        )}
        <input type="hidden" name="slides" value={slides ? JSON.stringify(slides) : ""} />
        <input type="hidden" name="slides_changed" value={slidesChanged ? "1" : "0"} />
        <div className="flex flex-col gap-2">
          <Label htmlFor="brief">Want a first draft?</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="brief"
              name="brief"
              maxLength={1000}
              placeholder="What's the post about? e.g. new autumn colours, restock on Friday"
              className="sm:flex-1"
            />
            <Button type="submit" variant="outline" formAction={draft} disabled={drafting}>
              {drafting ? "Drafting…" : "Draft with Claude"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            The draft goes into the caption box for you to edit. Nothing is posted until you say so.
          </p>
          <FormMessage>{draftState.error}</FormMessage>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="caption">Caption</Label>
          <textarea
            id="caption"
            name="caption"
            ref={captionRef}
            rows={6}
            maxLength={2200}
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            className={textarea}
          />
          <p className="text-muted-foreground text-xs tabular-nums">{caption.length} / 2,200</p>
          {accounts.map((account) => {
            const name = `${NETWORK_LABELS[account.network]} (${account.label})`;
            return (
              <div key={account.id} className="flex flex-col gap-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={`own_${account.id}`}
                    checked={own[account.id] ?? false}
                    onChange={(event) => setOwn({ ...own, [account.id]: event.target.checked })}
                  />
                  Different words for {name}
                </label>
                {own[account.id] && (
                  <textarea
                    name={`caption_${account.id}`}
                    rows={4}
                    maxLength={2200}
                    defaultValue={ownWords(account) ?? caption}
                    onChange={(event) =>
                      setOwnCaptions({ ...ownCaptions, [account.id]: event.target.value })
                    }
                    aria-label={`Caption for ${name}`}
                    className={textarea}
                  />
                )}
              </div>
            );
          })}
        </div>

        <fieldset className="flex flex-col gap-3">
          <legend className="pb-2 text-xs leading-tight font-semibold">
            Photos or a video{" "}
            <span className="text-muted-foreground font-normal">
              {hasVideo ? "(1 video)" : `(${picked.length} of 10)`}
            </span>
          </legend>
          {picked.map((id) => (
            <input key={id} type="hidden" name="asset" value={id} />
          ))}
          {picked.length > 0 && (
            <ol className="flex flex-wrap gap-3">
              {picked.map((id, index) => {
                const photo = byId.get(id);
                return (
                  <li key={id} className="flex w-24 flex-col gap-1">
                    {photo?.video ? (
                      <video
                        src={`${photo.url}#t=0.1`}
                        preload="metadata"
                        muted
                        playsInline
                        aria-label={photo.title || "Video"}
                        className="border-border size-24 rounded-md border object-cover"
                      />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
                      <img
                        src={photo?.url}
                        alt={photo?.title || `Photo ${index + 1}`}
                        className="border-border size-24 rounded-md border object-cover"
                      />
                    )}
                    <span className="flex justify-between text-xs">
                      <button
                        type="button"
                        onClick={() => move(id, -1)}
                        disabled={index === 0}
                        aria-label="Move earlier"
                        className="disabled:opacity-30"
                      >
                        ←
                      </button>
                      <button
                        type="button"
                        onClick={() => toggle(id)}
                        className="text-brick hover:underline"
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        onClick={() => move(id, 1)}
                        disabled={index === picked.length - 1}
                        aria-label="Move later"
                        className="disabled:opacity-30"
                      >
                        →
                      </button>
                    </span>
                    {photo?.designed && kit && (
                      <button
                        type="button"
                        onClick={() => void editDesign(id)}
                        className="text-ochre-text text-left text-xs hover:underline"
                      >
                        Edit design
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
          {picked
            .filter((id) => notes[id])
            .map((id) => (
              <p key={id} className="bg-note rounded-sm px-3 py-2 text-xs">
                {byId.get(id)?.title ? `“${byId.get(id)?.title}”` : "This photo"} is here because it{" "}
                {notes[id]}. Keep it only if it suits the post.{" "}
                <button
                  type="button"
                  onClick={() => toggle(id)}
                  className="text-brick font-semibold hover:underline"
                >
                  Take it off
                </button>
              </p>
            ))}
          {offer && !picked.includes(offer.id) && (
            <p className="bg-note flex flex-wrap items-center gap-2 rounded-sm px-3 py-2 text-xs">
              {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
              <img src={offer.url} alt="" className="size-8 rounded-sm object-cover" />
              <span>
                {offer.title ? `“${offer.title}”` : "A photo"} might suit this post: it{" "}
                {offer.reason}.
              </span>
              <button
                type="button"
                onClick={() => {
                  toggle(offer.id);
                  setOffer(null);
                }}
                className="text-ochre-text font-semibold hover:underline"
              >
                Add it
              </button>
            </p>
          )}
          <div className="flex flex-col gap-1.5">
            {slides && (
              <div className="flex flex-col gap-2">
                <p className="text-xs font-semibold">
                  Slides{" "}
                  <span className="text-muted-foreground font-normal">
                    ({slides.slides.length}, first on the post)
                  </span>
                </p>
                <SlideThumbs design={slides} kit={kit} />
                <p className="text-muted-foreground text-xs">
                  {slidesFixed
                    ? "This post is approved, so its slides are pictures now. Save it as a draft to change them."
                    : "Kept as one design on this post. They're made into pictures when it's approved or scheduled."}
                </p>
              </div>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!kit || slidesFixed}
                onClick={() => openDesigner()}
              >
                {slides ? "Edit the slides" : "Design slides"}
              </Button>
              {slides && !slidesFixed && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSlides(null);
                    setSlidesChanged(true);
                    setDesignNote("The slides come off when you save the post.");
                  }}
                >
                  Take the slides off
                </Button>
              )}
              {kit && firstPhoto && !slides && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openDesigner(firstPhoto.url)}
                >
                  Design around the first photo
                </Button>
              )}
            </div>
            <p className="text-muted-foreground text-xs">
              {kit ? (
                "Words on a colour or a photo, in your brand's look: one slide or a whole swipe-through. They stay editable on the post until it's approved."
              ) : (
                <>
                  Designed pictures use your colours.{" "}
                  <Link
                    href={`/w/${slug}/settings/brand`}
                    className="text-ochre-text hover:underline"
                  >
                    Set up your brand kit
                  </Link>{" "}
                  first.
                </>
              )}
            </p>
            {designNote && <p className="bg-note rounded-sm px-3 py-2 text-xs">{designNote}</p>}
          </div>
          {library.length > 0 && (
            <details>
              <summary className="text-ochre-text cursor-pointer text-sm font-medium">
                Pick from your assets
              </summary>
              <div className="mt-3 grid max-h-72 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-6 md:grid-cols-8">
                {library.map((photo) => (
                  <button
                    key={photo.id}
                    type="button"
                    onClick={() => toggle(photo.id)}
                    aria-pressed={picked.includes(photo.id)}
                    aria-label={photo.title || (photo.video ? "Video" : "Photo")}
                    className={cn(
                      "relative overflow-hidden rounded-md border-2",
                      picked.includes(photo.id) ? "border-ochre" : "border-transparent",
                    )}
                  >
                    {photo.video ? (
                      <>
                        <video
                          src={`${photo.url}#t=0.1`}
                          preload="metadata"
                          muted
                          playsInline
                          className="aspect-square w-full object-cover"
                        />
                        <span className="absolute top-0.5 right-0.5 rounded-sm bg-black/65 px-1 text-[10px] font-semibold text-white">
                          Video
                        </span>
                      </>
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
                      <img
                        src={photo.url}
                        alt=""
                        loading="lazy"
                        className="aspect-square w-full object-cover"
                      />
                    )}
                  </button>
                ))}
              </div>
            </details>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="photos">Add new photos</Label>
            <input
              id="photos"
              name="photos"
              type="file"
              multiple
              accept="image/jpeg,image/png"
              className="file:border-input text-sm file:mr-3 file:rounded-sm file:border file:bg-transparent file:px-3 file:py-1.5 file:text-sm file:font-semibold"
            />
            <p className="text-muted-foreground text-xs">
              JPEG or PNG, up to 5 MB each. Instagram needs JPEGs. Several photos become one
              swipe-through post. For a video, add it under Assets first, then pick it here; it goes
              out on its own, as a Reel on Instagram. TikTok takes a video only.
            </p>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="pb-2 text-xs leading-tight font-semibold">
            Post to{brand && brands.length > 1 ? ` · ${brand.name}'s accounts` : ""}
          </legend>
          <input type="hidden" name="accounts_shown" value="1" />
          {accounts.map((account) => (
            <label key={account.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                name="account"
                value={account.id}
                checked={ticked.includes(account.id)}
                onChange={(event) =>
                  setTicked((now) =>
                    event.target.checked
                      ? [...now, account.id]
                      : now.filter((id) => id !== account.id),
                  )
                }
                disabled={!account.canPost}
              />
              {NETWORK_LABELS[account.network]} · {account.label}
              {!account.canPost && (
                <span className="text-muted-foreground text-xs">
                  ({account.why ?? "can't post yet"})
                </span>
              )}
            </label>
          ))}
          {instagramAccounts.length > 0 && (
            <div className="flex flex-col gap-1 pl-6">
              <span className="text-muted-foreground text-xs">On Instagram, as</span>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="channel_instagram"
                  checked={feed}
                  onChange={(event) => setFeed(event.target.checked)}
                />
                A post (or a Reel, for a video)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="channel_instagram_story"
                  checked={story}
                  onChange={(event) => setStory(event.target.checked)}
                />
                A Story
              </label>
              <p className="text-muted-foreground text-xs">
                A Story is one photo or one video, with no caption, and stays up for a day. Photos
                that Instagram wouldn&apos;t take as they are (taller than 4:5 or wider than 1.91:1
                on the feed, anything but 9:16 in a Story) are sent as a copy cropped from the
                middle when you schedule; your photo stays as it is.
              </p>
            </div>
          )}
          {tiktokTicked.map((account) => (
            <TikTokChoices
              key={account.id}
              slug={slug}
              account={account}
              value={tiktok[account.id]}
              onChange={(next) => setTiktok((now) => ({ ...now, [account.id]: next }))}
              creator={creators[account.id]}
              onCreator={(found) => setCreators((now) => ({ ...now, [account.id]: found }))}
            />
          ))}
          {accounts.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {brands.length > 1 && brand
                ? `${brand.name} has no social accounts yet. Give it one under Settings → Social accounts. You can still save drafts.`
                : "Connect Facebook & Instagram, TikTok or LinkedIn on the Connections page to schedule posts. You can still save drafts."}
            </p>
          ) : (
            !connected && (
              <p className="text-muted-foreground text-xs">
                None of these accounts can be posted to yet (see why beside each). You can still
                save drafts.
              </p>
            )
          )}
          {problems.length > 0 && tickedAccounts.length > 0 && (
            <div className="bg-note rounded-sm px-3 py-2 text-xs" role="status">
              <p className="font-semibold">Before this can be scheduled:</p>
              <ul className="list-disc pl-4">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>

        {(projects.length > 0 || topics.length > 0) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {topics.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="topic">Topic</Label>
                <Select id="topic" name="topic" defaultValue={post?.topic ?? defaults.topic ?? ""}>
                  <option value="">No topic</option>
                  {topics.map((topic) => (
                    <option key={topic.id} value={topic.id}>
                      {topic.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            {projects.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="project">Project</Label>
                <Select
                  id="project"
                  name="project"
                  defaultValue={post?.projectId ?? defaults.projectId ?? ""}
                >
                  <option value="">No project</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </Select>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="day">Date</Label>
              <Input id="day" name="day" type="date" defaultValue={post?.day ?? defaults.day} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="time">Time</Label>
              <Input id="time" name="time" type="time" defaultValue={post?.time ?? defaults.time} />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            In your workspace&apos;s timezone ({timezone.replace(/_/g, " ")}).
          </p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="keep_date" defaultChecked={post ? post.planned : true} />
            If I save this as a draft, keep it pencilled in for then
          </label>
        </div>

        {review.state === "waiting" && <input type="hidden" name="after" value="review" />}
        <FormMessage>{prepError || state.error}</FormMessage>
        {preparing && (
          <p role="status" className="bg-note rounded-sm px-3 py-2 text-sm">
            {preparing}
          </p>
        )}
        <div className="flex flex-wrap gap-3" aria-busy={Boolean(preparing)}>
          {review.canSchedule ? (
            <>
              <SubmitButton
                name="intent"
                value="schedule"
                pendingText="Saving…"
                disabled={!connected || Boolean(preparing)}
              >
                {review.canApprove && review.state === "waiting"
                  ? "Approve and schedule"
                  : "Schedule"}
              </SubmitButton>
              <SubmitButton
                name="intent"
                value="now"
                variant="outline"
                disabled={!connected || Boolean(preparing)}
              >
                Post now
              </SubmitButton>
              {review.state !== "waiting" && !review.canApprove && (
                <SubmitButton name="intent" value="review" variant="outline">
                  Send for review
                </SubmitButton>
              )}
            </>
          ) : (
            <SubmitButton name="intent" value="review" pendingText="Sending…">
              {review.state === "waiting" ? "Save and keep it in review" : "Send for review"}
            </SubmitButton>
          )}
          <SubmitButton name="intent" value="draft" variant="outline">
            Save as draft
          </SubmitButton>
        </div>
        {!review.canSchedule && (
          <p className="text-muted-foreground text-xs">
            This workspace approves posts before they go out. An approver will look at it, then
            schedule it or send it back with a note.
          </p>
        )}
      </form>
    </>
  );
}

/** Small pictures of the slides, drawn here from the design (nothing is saved). */
function SlideThumbs({ design, kit }: { design: SlideDesign; kit: BrandKit | null }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let live = true;
    const made: string[] = [];
    void (async () => {
      for (const slide of design.slides) {
        try {
          const { blob } = await renderSlideBlob(slide, design, kit ?? undefined, { jpeg: true });
          made.push(URL.createObjectURL(blob));
        } catch {
          made.push("");
        }
      }
      if (live) setUrls([...made]);
    })();
    return () => {
      live = false;
      made.forEach((url) => url && URL.revokeObjectURL(url));
    };
  }, [design, kit]);
  return (
    <ol className="flex flex-wrap gap-2">
      {design.slides.map((slide, index) => (
        <li key={slide.id} className="w-20">
          {urls[index] ? (
            // eslint-disable-next-line @next/next/no-img-element -- drawn here, a blob address
            <img
              src={urls[index]}
              alt={`Slide ${index + 1}`}
              className="border-border w-20 rounded-sm border"
            />
          ) : (
            <span className="bg-muted text-muted-foreground flex aspect-[4/5] w-20 items-center justify-center rounded-sm text-xs">
              {index + 1}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Tries a post that only partly went out again: only the accounts that didn't get it. */
export function RetryPostForm({ slug, postId }: { slug: string; postId: string }) {
  const [state, action] = useActionState(retryPost.bind(null, slug, postId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="outline" size="sm" pendingText="Trying again…" className="w-fit">
        Try the rest again
      </SubmitButton>
      <p className="text-muted-foreground text-xs">
        Only the accounts it didn&apos;t reach are tried. What was posted is never sent twice.
      </p>
    </form>
  );
}

/**
 * For an account we never heard back about: a person looks on the network
 * and says whether the post is there. Nothing is sent again until they do.
 */
export function SettleTargetForm({
  slug,
  postId,
  target,
  network,
}: {
  slug: string;
  postId: string;
  target: string;
  network: string;
}) {
  const [wentState, went] = useActionState(settleTarget.bind(null, slug, postId, target, true), {});
  const [notState, notThere] = useActionState(
    settleTarget.bind(null, slug, postId, target, false),
    {},
  );
  const state = wentState.error || wentState.message ? wentState : notState;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs">Look on {network}. Is the post there?</p>
      <div className="flex flex-wrap gap-2">
        <form action={went}>
          <SubmitButton variant="outline" size="sm" pendingText="Saving…">
            Yes, it&apos;s there
          </SubmitButton>
        </form>
        <form action={notThere}>
          <SubmitButton variant="ghost" size="sm" pendingText="Saving…">
            No, it isn&apos;t
          </SubmitButton>
        </form>
      </div>
      <FormMessage>{state.error}</FormMessage>
      <FormMessage kind="success">{state.message}</FormMessage>
    </div>
  );
}

export function DeletePostForm({ slug, postId }: { slug: string; postId: string }) {
  const [state, action] = useActionState(deletePost.bind(null, slug, postId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <FormMessage>{state.error}</FormMessage>
      <SubmitButton variant="danger" size="sm" pendingText="Deleting…" className="w-fit">
        Delete this post
      </SubmitButton>
    </form>
  );
}

/**
 * TikTok's own choices for one account's post, as its rules for apps ask:
 * who can see it (from what TikTok says this account may choose, with no
 * choice made for the person), comments, duets and stitches (off until
 * switched on, and off for good where the creator switched them off in
 * TikTok), and whether it promotes a brand. Shown only while a TikTok
 * account is ticked.
 */
function TikTokChoices({
  slug,
  account,
  value,
  onChange,
  creator,
  onCreator,
}: {
  slug: string;
  account: ComposerAccount;
  value: TikTokOptions & { disclose: boolean };
  onChange(next: TikTokOptions & { disclose: boolean }): void;
  creator?: { choices: CreatorChoices | null; audited: boolean; error?: string };
  onCreator(found: { choices: CreatorChoices | null; audited: boolean; error?: string }): void;
}) {
  useEffect(() => {
    if (creator) return;
    let live = true;
    void loadTikTokChoices(slug, account.id).then((found) => {
      if (!live) return;
      onCreator(
        found.ok
          ? { choices: found.choices, audited: found.audited }
          : { choices: null, audited: found.audited, error: found.error },
      );
    });
    return () => {
      live = false;
    };
    // Asked once each time the account is shown, as TikTok asks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id]);
  const audited = creator?.audited ?? false;
  const levels = privacyChoices(creator?.choices ?? null, audited);
  const field = (name: string) => `tt_${name}_${account.id}`;
  const set = (patch: Partial<TikTokOptions & { disclose: boolean }>) =>
    onChange({ ...value, ...patch });
  const off = {
    comment: Boolean(creator?.choices?.commentDisabled),
    duet: Boolean(creator?.choices?.duetDisabled),
    stitch: Boolean(creator?.choices?.stitchDisabled),
  };
  return (
    <div className="border-border flex flex-col gap-2 rounded-md border p-3">
      <p className="text-sm font-semibold">On TikTok, as {account.label}</p>
      {!audited && (
        <p className="bg-ochre-soft text-ochre-text rounded-sm px-3 py-2 text-xs">
          TikTok hasn&apos;t reviewed our app yet, so for now TikTok only lets us post videos that
          only you can see. Once it&apos;s up you can change who sees it in the TikTok app.
        </p>
      )}
      {creator?.error && <p className="text-brick text-xs">{creator.error}</p>}
      {!creator && (
        <p className="text-muted-foreground text-xs">Asking TikTok what you can choose…</p>
      )}
      <label className="flex flex-col gap-1 text-sm">
        <span>Who can see it</span>
        <Select
          name={field("privacy")}
          value={value.privacy_level ?? ""}
          onChange={(event) =>
            set({ privacy_level: (event.target.value || null) as TikTokOptions["privacy_level"] })
          }
        >
          <option value="">Choose who can see it</option>
          {levels.map((level) => (
            <option key={level} value={level}>
              {PRIVACY_LABELS[level]}
            </option>
          ))}
        </Select>
      </label>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {(
          [
            ["comment", "allow_comment", "Comments"],
            ["duet", "allow_duet", "Duets"],
            ["stitch", "allow_stitch", "Stitches"],
          ] as const
        ).map(([name, key, label]) => (
          <label key={name} className="flex items-center gap-2">
            <input
              type="checkbox"
              name={field(name)}
              checked={value[key] && !off[name]}
              disabled={off[name]}
              onChange={(event) => set({ [key]: event.target.checked })}
            />
            Allow {label.toLowerCase()}
            {off[name] && <span className="text-muted-foreground text-xs">(off in TikTok)</span>}
          </label>
        ))}
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name={field("disclose")}
          checked={value.disclose}
          onChange={(event) =>
            set(
              event.target.checked
                ? { disclose: true }
                : { disclose: false, brand_organic: false, brand_content: false },
            )
          }
        />
        This video promotes a brand, a product or a service
      </label>
      {value.disclose && (
        <div className="flex flex-col gap-1 pl-6 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name={field("brand_organic")}
              checked={value.brand_organic}
              onChange={(event) => set({ brand_organic: event.target.checked })}
            />
            Your brand (it promotes your own business)
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              name={field("brand_content")}
              checked={value.brand_content}
              onChange={(event) => set({ brand_content: event.target.checked })}
            />
            Branded content (a paid partnership with another brand; it can&apos;t be private)
          </label>
          <p className="text-muted-foreground text-xs">
            TikTok labels it as{" "}
            {value.brand_content ? "“Paid partnership”" : "“Promotional content”"}.
          </p>
        </div>
      )}
      <p className="text-muted-foreground text-xs">
        By posting, you agree to TikTok&apos;s{" "}
        {value.brand_content ? (
          <>
            <a
              className="text-ochre-text hover:underline"
              href="https://www.tiktok.com/legal/page/global/bc-policy/en"
              target="_blank"
              rel="noreferrer"
            >
              Branded Content Policy
            </a>{" "}
            and{" "}
          </>
        ) : null}
        <a
          className="text-ochre-text hover:underline"
          href="https://www.tiktok.com/legal/page/global/music-usage-confirmation/en"
          target="_blank"
          rel="noreferrer"
        >
          Music Usage Confirmation
        </a>
        . TikTok can take a few minutes to finish a video after it&apos;s sent.
      </p>
    </div>
  );
}
