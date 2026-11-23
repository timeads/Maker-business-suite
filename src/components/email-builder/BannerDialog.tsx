"use client";

import { DesignDialog } from "@/components/slides/DesignDialog";
import type { SlideDesign } from "@/lib/design/slide-design";
import { useHost } from "./host";

/**
 * The banner open in the designer. Nothing changes in the email until "Use this banner" is
 * pressed; then its picture is made again and the email shows the new one.
 */
export function BannerDialog({
  design,
  onClose,
  onUse,
}: {
  design: SlideDesign;
  onClose: () => void;
  onUse: (design: SlideDesign) => Promise<void>;
}) {
  const host = useHost();
  if (!host.kit) return null;
  return (
    <DesignDialog
      initial={design}
      kit={host.kit}
      loadPhotos={async () =>
        (await host.listPhotos()).map((photo) => ({ ...photo, tags: photo.tags ?? [] }))
      }
      title="Edit the banner"
      description="Click any text to change it, drag to move it, or change the layout, colour and photo. The picture in the email is made again when you use it."
      saveLabel="Use this banner"
      single
      onClose={onClose}
      onSave={(edited) => onUse({ v: 1, format: "3:2", slides: [edited.slides[0]] })}
    />
  );
}
