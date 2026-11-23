"use client";

import { useMemo } from "react";
import { EmailBuilder } from "@/components/email-builder/EmailBuilder";
import type { BuilderHost } from "@/components/email-builder/host";
import type { EmailDoc, EmailTemplate } from "@/lib/design";
import {
  listPhotos,
  loadSavedSections,
  loadTemplates,
  saveEmailDoc,
  storeSavedSections,
  storeTemplates,
} from "../actions";

/** Connects the builder to this workspace: where the email is saved and whose brand it wears. */
export function BuilderMount({
  slug,
  id,
  initial,
  brandName,
  swatches,
  starters,
  logo,
  canKeepShared,
}: {
  slug: string;
  id: string;
  initial: EmailDoc;
  brandName: string;
  swatches: { name: string; hex: string }[];
  starters: EmailTemplate[];
  logo: string | null;
  canKeepShared: boolean;
}) {
  const host = useMemo<BuilderHost>(
    () => ({
      exitHref: `/w/${slug}/social/emails`,
      save: (doc) => saveEmailDoc(slug, id, doc),
      loadSavedSections: () => loadSavedSections(slug),
      storeSavedSections: (list) => storeSavedSections(slug, list),
      loadTemplates: () => loadTemplates(slug),
      storeTemplates: (list) => storeTemplates(slug, list),
      listPhotos: () => listPhotos(slug),
      logos: { badge: null, dark: logo, light: logo },
      checkLinks: async () => ({
        unavailable:
          "Checking links live isn't switched on yet. Open each link once before you send.",
      }),
      canKeepShared,
      brandName,
      swatches,
      starters,
    }),
    [slug, id, logo, canKeepShared, brandName, swatches, starters],
  );
  return (
    <>
      <div className="flex h-dvh flex-col items-center justify-center gap-3 p-6 text-center text-sm min-[900px]:hidden">
        <p>The email builder needs a wider screen. Open this email on a computer.</p>
        <a href={host.exitHref} className="text-ochre-text hover:underline">
          Back to emails
        </a>
      </div>
      <div className="max-[899px]:hidden">
        <EmailBuilder id={id} initial={initial} host={host} />
      </div>
    </>
  );
}
