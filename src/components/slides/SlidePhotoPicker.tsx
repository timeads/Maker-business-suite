"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/email-builder/ui";

/** A photo from the workspace's assets that a design can use. */
export type StudioPhoto = { id: string; url: string; title: string; tags: string[] };

function PhotoGrid({
  load,
  onSelect,
}: {
  load: () => Promise<StudioPhoto[]>;
  onSelect: (photo: StudioPhoto) => void;
}) {
  const [photos, setPhotos] = useState<StudioPhoto[] | null>(null);
  const [problem, setProblem] = useState(false);
  const [search, setSearch] = useState("");
  // Counted up to read the assets again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let wanted = true;
    load()
      .then((list) => {
        if (wanted) setPhotos(list);
      })
      .catch(() => {
        if (wanted) setProblem(true);
      });
    return () => {
      wanted = false;
    };
    // Read when the picker opens and when asked again, not each time the page around it draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (problem) {
    return (
      <div className="space-y-3 py-6 text-center" role="alert">
        <p className="text-sm">Your photos couldn&apos;t be loaded. Check your connection.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setProblem(false);
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }
  if (!photos) {
    return (
      <p
        className="text-muted-foreground flex items-center justify-center gap-2 py-10 text-sm"
        role="status"
      >
        <Loader2 className="size-4 animate-spin" aria-hidden /> Fetching your photos…
      </p>
    );
  }
  if (photos.length === 0) {
    return (
      <p className="border-border text-muted-foreground rounded-md border border-dashed p-6 text-center text-sm">
        There are no photos in your assets yet. Add some under Social, Assets, then come back and
        choose one.
      </p>
    );
  }
  const words = search.trim().toLowerCase();
  const shown = words
    ? photos.filter(
        (p) => p.title.toLowerCase().includes(words) || p.tags.some((tag) => tag.includes(words)),
      )
    : photos;
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Input
        type="search"
        aria-label="Search your photos"
        placeholder="Search by name or tag"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {shown.length === 0 ? (
        <p className="text-muted-foreground py-6 text-center text-sm">No photos match that.</p>
      ) : (
        <ul
          className="grid min-h-0 grid-cols-3 gap-2 overflow-y-auto p-0.5 sm:grid-cols-4"
          aria-label="Your photos"
        >
          {shown.map((photo) => (
            <li key={photo.id}>
              <button
                type="button"
                title={photo.title}
                aria-label={`Use ${photo.title || "this photo"}`}
                onClick={() => onSelect(photo)}
                className="group border-border bg-sunken hover:border-ochre focus-visible:ring-ring block w-full overflow-hidden rounded-md border text-left outline-none focus-visible:ring-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- an upload in the workspace's own storage */}
                <img
                  crossOrigin="anonymous"
                  src={photo.url}
                  alt=""
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
                <span className="bg-card block truncate px-1.5 py-1 text-[11px]">
                  {photo.title || photo.tags.slice(0, 2).join(", ") || "Untitled"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Choose one photo from the workspace's assets. Photos never come from anywhere else. */
export function SlidePhotoPicker({
  open,
  onOpenChange,
  load,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  load: () => Promise<StudioPhoto[]>;
  onSelect: (photo: StudioPhoto) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Choose a photo</DialogTitle>
          <DialogDescription>From your assets. Click one to use it.</DialogDescription>
        </DialogHeader>
        {open && <PhotoGrid load={load} onSelect={onSelect} />}
      </DialogContent>
    </Dialog>
  );
}
