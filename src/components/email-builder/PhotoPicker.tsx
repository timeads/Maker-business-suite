"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { safeUrl } from "@/lib/design";
import { useHost } from "./host";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui";

type Photo = { id: string; url: string; title: string };

/** The photos, read from the workspace's library each time the picker is opened. */
function PhotoGrid({ onSelect }: { onSelect: (url: string) => void }) {
  const host = useHost();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [problem, setProblem] = useState("");
  const [search, setSearch] = useState("");
  // Counted up to read the library again.
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let wanted = true;
    host
      .listPhotos()
      .then((list) => {
        if (!wanted) return;
        // Only pictures an email can safely point at are offered.
        setPhotos(list.filter((p) => safeUrl(p.url) && !/\.(mp4|mov|webm|avi|mkv)$/i.test(p.url)));
        setProblem("");
      })
      .catch((err: unknown) => {
        if (wanted) setProblem(err instanceof Error ? err.message : String(err));
      });
    return () => {
      wanted = false;
    };
    // The library is read when the picker opens and when asked again, not each time the page around it draws.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  if (problem) {
    return (
      <div className="space-y-3 py-6 text-center" role="alert">
        <p className="text-sm">Your photos could not be loaded: {problem}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setProblem("");
            setPhotos(null);
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
        There are no photos in your library yet. Add some there, then come back and choose one.
      </p>
    );
  }
  const words = search.trim().toLowerCase();
  const shown = words ? photos.filter((p) => p.title.toLowerCase().includes(words)) : photos;
  return (
    <div className="flex min-h-0 flex-col gap-3">
      {photos.length > 12 && (
        <Input
          type="search"
          aria-label="Search your photos"
          placeholder="Search by name"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      )}
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
                onClick={() => onSelect(photo.url)}
                className="group border-border bg-sunken hover:border-ochre focus-visible:ring-ring block w-full overflow-hidden rounded-md border text-left outline-none focus-visible:ring-2"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- library photos live on the workspace's own storage, at addresses not known ahead of time */}
                <img
                  src={photo.url}
                  alt=""
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
                <span className="bg-card block truncate px-1.5 py-1 text-[11px]">
                  {photo.title || "Untitled"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Choose one photo from the workspace's library. Gives back its address. */
export function PhotoPicker({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (url: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col">
        <DialogHeader>
          <DialogTitle>Choose a photo</DialogTitle>
          <DialogDescription>From your library. Click one to use it.</DialogDescription>
        </DialogHeader>
        <PhotoGrid onSelect={onSelect} />
      </DialogContent>
    </Dialog>
  );
}
