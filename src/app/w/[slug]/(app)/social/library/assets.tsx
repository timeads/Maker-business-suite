"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState, useTransition } from "react";
import { Film, Folder as FolderIcon, Paintbrush, Upload } from "lucide-react";
import { DesignDialog } from "@/components/slides/DesignDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import { Input, Select } from "@/components/ui/input";
import { SubmitButton } from "@/components/ui/submit-button";
import type { BrandKit } from "@/lib/design/brands";
import type { SlideDesign } from "@/lib/design/slide-design";
import { getBrowserClient } from "@/lib/supabase/browser";
import { cn } from "@/lib/utils";
import {
  finishUpload,
  importProductPhotos,
  listDesignPhotos,
  loadAssetDesign,
  removeFolder,
  saveFolder,
  sortAssets,
  startUpload,
} from "../actions";
import { designTitle, saveDesignAsPictures } from "../designed";

export type Asset = {
  id: string;
  url: string;
  title: string;
  tags: string[];
  video: boolean;
  bytes: number;
};
export type FolderOption = { id: string; name: string; count: number };

const ACCEPT = "image/jpeg,image/png,video/mp4,video/quicktime";
const size = (bytes: number) =>
  bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Drop files or pick them; each goes straight to storage with its own progress line. */
export function Uploader({
  slug,
  folder,
}: {
  slug: string;
  /** The folder being looked at, which new files go into. */
  folder: { id: string; name: string } | null;
}) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState<{ done: number; total: number } | null>(null);
  const [note, setNote] = useState<{ kind: "error" | "success"; text: string } | null>(null);

  async function send(list: FileList | File[]) {
    const files = [...list];
    if (files.length === 0 || busy) return;
    setNote(null);
    setBusy({ done: 0, total: files.length });
    const started = await startUpload(
      slug,
      files.map((file) => ({ type: file.type, size: file.size })),
    );
    if ("error" in started) {
      setBusy(null);
      setNote({ kind: "error", text: started.error });
      return;
    }
    const storage = getBrowserClient().storage.from("social");
    const arrived: { path: string; title: string }[] = [];
    for (const [index, file] of files.entries()) {
      const ticket = started.tickets[index];
      const { error } = await storage.uploadToSignedUrl(ticket.path, ticket.token, file, {
        contentType: file.type,
      });
      if (!error) {
        arrived.push({ path: ticket.path, title: file.name.replace(/\.[^.]+$/, "").slice(0, 120) });
      }
      setBusy({ done: index + 1, total: files.length });
    }
    const result =
      arrived.length > 0
        ? await finishUpload(slug, arrived, folder?.id ?? null, tags)
        : { error: "Those files didn't upload. Check your connection and try again." };
    setBusy(null);
    if ("error" in result) {
      setNote({ kind: "error", text: result.error });
    } else {
      const missed = files.length - result.added;
      setNote({
        kind: missed ? "error" : "success",
        text: `${result.added} added${folder ? ` to ${folder.name}` : ""}.${missed ? ` ${missed} didn't upload.` : ""}`,
      });
      router.refresh();
    }
    if (input.current) input.current.value = "";
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void send(e.dataTransfer.files);
        }}
        className={cn(
          "bg-card flex flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center",
          over ? "border-teal bg-hover" : "border-border",
        )}
      >
        <Upload aria-hidden className="text-muted-foreground size-6" />
        <p className="text-sm">
          Drop photos and videos here{folder ? ` to add them to ${folder.name}` : ""}
        </p>
        <p className="text-muted-foreground text-xs">
          JPEG or PNG up to 8 MB. MP4 or MOV up to 50 MB.
        </p>
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          aria-label="Choose files"
          onChange={(e) => e.target.files && void send(e.target.files)}
        />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Tags for these (optional)"
            aria-label="Tags for these files"
            className="w-56"
          />
          <Button type="button" disabled={Boolean(busy)} onClick={() => input.current?.click()}>
            {busy ? `Uploading ${busy.done} of ${busy.total}…` : "Choose files"}
          </Button>
        </div>
        {busy && (
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={busy.total}
            aria-valuenow={busy.done}
            className="bg-sunken h-1.5 w-full max-w-xs overflow-hidden rounded-full"
          >
            <div
              className="bg-teal h-full transition-[width]"
              style={{ width: `${(busy.done / busy.total) * 100}%` }}
            />
          </div>
        )}
      </div>
      {note && <FormMessage kind={note.kind}>{note.text}</FormMessage>}
    </div>
  );
}

/** Folder tiles, with a small form to add one. */
export function Folders({
  slug,
  folders,
  loose,
  canWrite,
}: {
  slug: string;
  folders: FolderOption[];
  /** How many files sit outside every folder. */
  loose: number;
  canWrite: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [state, action] = useActionState(saveFolder.bind(null, slug, null), {});
  const base = `/w/${slug}/social/library`;
  if (folders.length === 0 && !canWrite) return null;
  return (
    <section aria-label="Folders" className="flex flex-col gap-2">
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {folders.map((folder) => (
          <li key={folder.id}>
            <Link
              href={`${base}?folder=${folder.id}`}
              className="bg-card hover:bg-hover flex items-center gap-2 rounded-lg border p-3"
            >
              <FolderIcon aria-hidden className="text-teal size-5 shrink-0" />
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold">{folder.name}</span>
                <span className="text-muted-foreground block text-xs">
                  {folder.count} {folder.count === 1 ? "item" : "items"}
                </span>
              </span>
            </Link>
          </li>
        ))}
        {canWrite && !adding && (
          <li>
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="text-text-2 hover:bg-hover flex h-full w-full items-center gap-2 rounded-lg border border-dashed p-3 text-sm"
            >
              <FolderIcon aria-hidden className="size-5 shrink-0" /> New folder
            </button>
          </li>
        )}
      </ul>
      {adding && (
        <form action={action} className="flex flex-wrap items-center gap-2">
          <Input
            name="name"
            required
            maxLength={60}
            autoFocus
            placeholder="Folder name"
            aria-label="Folder name"
            className="w-56"
          />
          <SubmitButton variant="outline" size="sm" pendingText="Adding…">
            Add folder
          </SubmitButton>
          <Button type="button" variant="ghost" size="sm" onClick={() => setAdding(false)}>
            Cancel
          </Button>
        </form>
      )}
      <FormMessage>{state.error}</FormMessage>
      {folders.length > 0 && loose > 0 && (
        <p className="text-muted-foreground text-xs">{loose} not in a folder yet, shown below.</p>
      )}
    </section>
  );
}

/** Rename or remove the folder being looked at. */
export function FolderTools({
  slug,
  folder,
}: {
  slug: string;
  folder: { id: string; name: string };
}) {
  const [state, action] = useActionState(saveFolder.bind(null, slug, folder.id), {});
  const [pending, start] = useTransition();
  return (
    <details className="text-sm">
      <summary className="text-text-2 cursor-pointer">Rename or remove this folder</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <form action={action} className="flex items-center gap-2">
          <Input
            name="name"
            required
            maxLength={60}
            defaultValue={folder.name}
            aria-label="Folder name"
            className="w-56"
          />
          <SubmitButton variant="outline" size="sm" pendingText="Saving…">
            Rename
          </SubmitButton>
        </form>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={pending}
          onClick={() => {
            if (
              window.confirm(
                `Remove the folder "${folder.name}"? Everything in it stays in your library.`,
              )
            ) {
              start(() => removeFolder(slug, folder.id));
            }
          }}
        >
          Remove folder
        </Button>
      </div>
      <FormMessage>{state.error}</FormMessage>
    </details>
  );
}

/** The grid. Tick several to move, tag or put away in one go; click one to open it. */
export function AssetGrid({
  slug,
  assets,
  folders,
  canWrite,
  openId,
  hrefFor,
  putAway,
}: {
  slug: string;
  assets: Asset[];
  folders: FolderOption[];
  canWrite: boolean;
  openId: string | null;
  /** Link that opens one asset, keeping the current filters. */
  hrefFor: Record<string, string>;
  putAway: boolean;
}) {
  const router = useRouter();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [moveTo, setMoveTo] = useState("");
  const [tags, setTags] = useState("");
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const toggle = (id: string) =>
    setPicked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const run = (change: Parameters<typeof sortAssets>[2]) =>
    start(async () => {
      const result = await sortAssets(slug, [...picked], change);
      if (result.error) return setError(result.error);
      setError("");
      setPicked(new Set());
      setTags("");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3">
      {canWrite && picked.size > 0 && (
        <div
          role="region"
          aria-label="Selected files"
          className="bg-note sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border p-2 text-sm"
        >
          <strong className="px-1">{picked.size} selected</strong>
          <Select
            value={moveTo}
            onChange={(e) => setMoveTo(e.target.value)}
            aria-label="Move to folder"
            className="w-44"
          >
            <option value="">Move to…</option>
            <option value="none">No folder</option>
            {folders.map((folder) => (
              <option key={folder.id} value={folder.id}>
                {folder.name}
              </option>
            ))}
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || !moveTo}
            onClick={() => run({ moveTo: moveTo === "none" ? null : moveTo })}
          >
            Move
          </Button>
          <Input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            placeholder="Add tags"
            aria-label="Tags to add"
            className="w-36"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending || !tags.trim()}
            onClick={() => run({ tags })}
          >
            Tag
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => run({ hidden: !putAway })}
          >
            {putAway ? "Bring back" : "Put away"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setPicked(new Set())}
          >
            Clear
          </Button>
          {assets.length > picked.size && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPicked(new Set(assets.map((asset) => asset.id)))}
            >
              Select all
            </Button>
          )}
        </div>
      )}
      <FormMessage>{error}</FormMessage>
      <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6">
        {assets.map((asset) => (
          <li key={asset.id} className="relative">
            <Link
              href={hrefFor[asset.id]}
              scroll={false}
              className={cn(
                "bg-sunken relative block overflow-hidden rounded-md border-2",
                openId === asset.id || picked.has(asset.id) ? "border-ochre" : "border-transparent",
              )}
            >
              {asset.video ? (
                <>
                  <video
                    src={`${asset.url}#t=0.1`}
                    preload="metadata"
                    muted
                    playsInline
                    aria-label={asset.title || "Video"}
                    className="aspect-square w-full object-cover"
                  />
                  <span className="absolute top-1 right-1 flex items-center gap-1 rounded-sm bg-black/65 px-1.5 py-0.5 text-[11px] font-semibold text-white">
                    <Film aria-hidden className="size-3" /> Video · {size(asset.bytes)}
                  </span>
                </>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element -- a user upload on another host
                <img
                  src={asset.url}
                  alt={asset.title || "Photo"}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              )}
              {asset.tags.length > 0 && (
                <span className="absolute inset-x-1 bottom-1 flex flex-wrap gap-0.5">
                  {asset.tags.slice(0, 2).map((name) => (
                    <Badge key={name} tone="open">
                      {name}
                    </Badge>
                  ))}
                </span>
              )}
            </Link>
            {canWrite && (
              <input
                type="checkbox"
                checked={picked.has(asset.id)}
                onChange={() => toggle(asset.id)}
                aria-label={`Select ${asset.title || (asset.video ? "video" : "photo")}`}
                className="absolute top-1.5 left-1.5 size-4 cursor-pointer"
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Opens a designed picture in the designer again. Saving makes a new picture and puts the old
 * one away, unless a post that has gone out used it; that one stays where it is.
 */
export function EditDesign({
  slug,
  assetId,
  title,
  kit,
  jpeg,
  libraryHref,
}: {
  slug: string;
  assetId: string;
  title: string;
  kit: BrandKit;
  /** Whether the picture is a JPEG, which the new one then is too. */
  jpeg: boolean;
  /** The library as it is being looked at, without a picture open. */
  libraryHref: string;
}) {
  const router = useRouter();
  const [design, setDesign] = useState<SlideDesign | null>(null);
  const [problem, setProblem] = useState("");
  const [opening, startOpening] = useTransition();
  const open = () =>
    startOpening(async () => {
      setProblem("");
      const found = await loadAssetDesign(slug, assetId);
      if ("error" in found) setProblem(found.error);
      else setDesign(found.design);
    });
  const save = async (next: SlideDesign) => {
    const [picture] = await saveDesignAsPictures(slug, next, kit, {
      jpeg,
      title: title || designTitle(next, "Designed picture"),
      replaces: assetId,
    });
    setDesign(null);
    router.replace(`${libraryHref}${libraryHref.includes("?") ? "&" : "?"}open=${picture.id}`, {
      scroll: false,
    });
    router.refresh();
  };
  return (
    <div className="flex flex-col gap-2 border-t pt-4">
      <p className="text-muted-foreground text-xs">
        This picture was made in the designer, so its words, colours and photos can still be
        changed. Saving makes a new picture; a post that has already gone out keeps the old one.
      </p>
      <Button type="button" variant="outline" className="w-fit" disabled={opening} onClick={open}>
        <Paintbrush aria-hidden /> {opening ? "Opening…" : "Edit design"}
      </Button>
      <FormMessage>{problem}</FormMessage>
      {design && (
        <DesignDialog
          initial={design}
          kit={kit}
          loadPhotos={() => listDesignPhotos(slug)}
          title="Edit this design"
          description="Click any text to change it, drag to move it, or change the layout, colour and photos. The new picture is made when you save."
          saveLabel="Save the new picture"
          single
          onClose={() => setDesign(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

/** Copies product photos from the connected shop into the library, a batch at a time. */
export function ProductPhotosButton({ slug }: { slug: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ kind: "error" | "success"; text: string } | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const result = await importProductPhotos(slug);
            if ("error" in result) return setNote({ kind: "error", text: result.error });
            setNote({
              kind: "success",
              text:
                result.added === 0 && result.left === 0
                  ? "Every product photo is already here."
                  : `${result.added} product ${result.added === 1 ? "photo" : "photos"} added, tagged "product".${result.left > 0 ? ` ${result.left} more to go: press again.` : ""}`,
            });
            router.refresh();
          })
        }
      >
        {pending ? "Bringing them in…" : "Bring in product photos from your shop"}
      </Button>
      {note && <FormMessage kind={note.kind}>{note.text}</FormMessage>}
    </div>
  );
}
