"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FormMessage } from "@/components/ui/form-message";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/email-builder/ui";
import type { BrandKit } from "@/lib/design/brands";
import type { SlideDesign } from "@/lib/design/slide-design";
import { SlideStudio } from "./SlideStudio";
import type { StudioPhoto } from "./SlidePhotoPicker";

/**
 * The designer in a dialog. Nothing outside changes until the save button is pressed; `onSave`
 * draws and keeps the pictures, and the dialog stays open with a plain message if that fails.
 * Mount it only while it is open, so each opening starts from the design it is given.
 */
export function DesignDialog({
  initial,
  kit,
  loadPhotos,
  title,
  description,
  saveLabel,
  single = false,
  onClose,
  onSave,
}: {
  initial: SlideDesign;
  kit: BrandKit;
  loadPhotos: () => Promise<StudioPhoto[]>;
  title: string;
  description: string;
  saveLabel: string;
  single?: boolean;
  onClose: () => void;
  onSave: (design: SlideDesign) => Promise<void>;
}) {
  const [design, setDesign] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState("");
  const save = async () => {
    setSaving(true);
    setProblem("");
    try {
      await onSave(design);
    } catch (err) {
      setProblem(
        err instanceof Error && err.message
          ? err.message
          : "The picture couldn't be saved. Please try again.",
      );
      setSaving(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="block max-h-[92vh] max-w-5xl space-y-4 overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <SlideStudio
          design={design}
          onChange={setDesign}
          kit={kit}
          loadPhotos={loadPhotos}
          single={single}
        />
        <FormMessage>{problem}</FormMessage>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={save} disabled={saving}>
            {saving && <Loader2 className="animate-spin" aria-hidden />}
            {saving ? "Making the picture…" : saveLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
