"use client";

import { useEffect, useRef, useState } from "react";
import { Download, FileText, Film, Paperclip, X } from "lucide-react";
import { fileSize } from "@/lib/helpdesk/outbound";
import { isPicture, isVideo, notKeptWords } from "@/lib/helpdesk/files";
import { cn } from "@/lib/utils";

export type ShownFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  kept: boolean;
  reason: string | null;
};

/** A kept file's own address: our route, which checks who is asking every time. */
export const fileHref = (id: string, download = false) =>
  `/api/helpdesk/files/${id}${download ? "?download=1" : ""}`;

const chip =
  "border-border bg-card hover:bg-hover focus-visible:ring-ochre flex max-w-full items-center gap-1.5 rounded-sm border px-2 py-1 text-xs outline-none focus-visible:ring-2";

/** A picture or video opened large, over the page. Escape or a press outside closes it. */
function Lightbox({ file, onClose }: { file: ShownFile; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-label={file.name}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) dialog.current?.close();
      }}
      className="m-auto max-h-[94dvh] max-w-[96vw] rounded-lg bg-transparent p-0 backdrop:bg-black/75"
    >
      <div className="bg-card flex max-h-[94dvh] flex-col overflow-hidden rounded-lg">
        <div className="border-border flex items-center gap-2 border-b px-3 py-2 text-sm">
          <span className="font-read min-w-0 flex-1 truncate font-semibold">{file.name}</span>
          <span className="text-muted-foreground shrink-0 text-xs">{fileSize(file.size)}</span>
          <a
            href={fileHref(file.id, true)}
            title="Download"
            aria-label={`Download ${file.name}`}
            className="text-text-2 hover:bg-hover flex size-8 items-center justify-center rounded-sm"
          >
            <Download aria-hidden className="size-4" />
          </a>
          <button
            type="button"
            onClick={() => dialog.current?.close()}
            aria-label="Close"
            className="text-text-2 hover:bg-hover flex size-8 items-center justify-center rounded-sm"
          >
            <X aria-hidden className="size-4" />
          </button>
        </div>
        <div className="bg-sunken flex min-h-0 flex-1 items-center justify-center overflow-auto">
          {isVideo(file.type) ? (
            <video
              src={fileHref(file.id)}
              controls
              autoPlay
              playsInline
              className="max-h-[84dvh] max-w-full"
            />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- a customer's own picture, served by our route to this member only
            <img
              src={fileHref(file.id)}
              alt={file.name}
              className="max-h-[84dvh] max-w-full object-contain"
            />
          )}
        </div>
      </div>
    </dialog>
  );
}

/** One picture, drawn small. If the browser can't draw it (a HEIC on most), it becomes a download chip. */
function Thumb({
  file,
  onOpen,
  inline,
}: {
  file: ShownFile;
  onOpen: () => void;
  inline?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  if (broken) return <FileChip file={file} onOpen={onOpen} />;
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`${file.name} · ${fileSize(file.size)}`}
      aria-label={`Open ${file.name}`}
      className={cn(
        "border-border bg-sunken focus-visible:ring-ochre block overflow-hidden rounded-md border outline-none focus-visible:ring-2",
        inline ? "my-2 max-w-full" : "size-24",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- our own element pointing at our own route; never the email's markup */}
      <img
        src={fileHref(file.id)}
        alt={file.name}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={inline ? "max-h-80 max-w-full object-contain" : "size-full object-cover"}
      />
    </button>
  );
}

function FileChip({ file, onOpen }: { file: ShownFile; onOpen: () => void }) {
  const Icon = isVideo(file.type) ? Film : file.type === "application/pdf" ? FileText : Paperclip;
  const inner = (
    <>
      <Icon aria-hidden className="text-muted-foreground size-3.5 shrink-0" />
      <span className="font-read truncate font-semibold">{file.name}</span>
      <span className="text-muted-foreground shrink-0">{fileSize(file.size)}</span>
    </>
  );
  if (!file.kept) {
    return (
      <span
        className="border-border text-muted-foreground flex max-w-full items-center gap-1.5 rounded-sm border border-dashed px-2 py-1 text-xs"
        title={`A file we didn't keep: ${notKeptWords(file.reason)}`}
      >
        <Paperclip aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">
          A file we didn&apos;t keep: <span className="font-read font-semibold">{file.name}</span>,{" "}
          {file.type}, {fileSize(file.size)} ({notKeptWords(file.reason)})
        </span>
      </span>
    );
  }
  if (isVideo(file.type)) {
    return (
      <button type="button" onClick={onOpen} className={chip} aria-label={`Play ${file.name}`}>
        {inner}
      </button>
    );
  }
  // A PDF opens beside the desk; anything else comes down as a file.
  const pdf = file.type === "application/pdf";
  return (
    <a
      href={fileHref(file.id, !pdf)}
      {...(pdf ? { target: "_blank", rel: "noopener noreferrer" } : {})}
      className={chip}
      title={pdf ? `Open ${file.name}` : `Download ${file.name}`}
    >
      {inner}
    </a>
  );
}

/**
 * What came with a message: pictures as thumbnails, everything else as a
 * chip with its name and size. Pictures and video open large over the page.
 * Every element here is ours; nothing from the email's own markup is drawn.
 */
export function MessageFiles({ files, inline }: { files: ShownFile[]; inline?: boolean }) {
  const [open, setOpen] = useState<ShownFile | null>(null);
  if (files.length === 0) return null;
  const drawn = (file: ShownFile) =>
    file.kept && (isPicture(file.type) || file.type === "image/heic");
  const pictures = files.filter(drawn);
  const rest = files.filter((file) => !drawn(file));
  if (inline) {
    return (
      <>
        {pictures.map((file) => (
          <Thumb key={file.id} file={file} inline onOpen={() => setOpen(file)} />
        ))}
        {open && <Lightbox file={open} onClose={() => setOpen(null)} />}
      </>
    );
  }
  return (
    <div className="mt-3 flex flex-col gap-2">
      {pictures.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {pictures.map((file) => (
            <li key={file.id} className="flex max-w-full flex-col gap-0.5">
              <Thumb file={file} onOpen={() => setOpen(file)} />
              <span className="text-muted-foreground w-24 truncate text-[11px]">
                {file.name} · {fileSize(file.size)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {rest.map((file) => (
            <li key={file.id} className="max-w-full">
              <FileChip file={file} onOpen={() => setOpen(file)} />
            </li>
          ))}
        </ul>
      )}
      {open && <Lightbox file={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
