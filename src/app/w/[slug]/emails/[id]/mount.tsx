"use client";

import { useMemo } from "react";
import { EmailBuilder } from "@/components/email-builder/EmailBuilder";
import type { BuilderHost } from "@/components/email-builder/host";
import type { EmailDoc, EmailTemplate } from "@/lib/design";
import type { BrandKit } from "@/lib/design/brands";
import { designTitle, saveDesignAsPictures } from "../../(app)/social/designed";
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
  kit,
  logos,
  canKeepShared,
}: {
  slug: string;
  id: string;
  initial: EmailDoc;
  brandName: string;
  swatches: { name: string; hex: string }[];
  starters: EmailTemplate[];
  /** The workspace's kit as the banner designer draws with it, or null until a brand kit is set up. */
  kit: BrandKit | null;
  /** The assets tagged `logo` and `logo-light`. */
  logos: { onLight: string | null; onDark: string | null };
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
      logos: { badge: null, dark: logos.onLight, light: logos.onDark ?? logos.onLight },
      kit,
      // The picture is drawn here in the browser, sent straight to the workspace's storage with a
      // one-time link, and registered (with its design) by the server, which gives back its address.
      makeBanner: async (design) => {
        if (!kit) throw new Error("Set up your brand kit first, so the banner is in your colours.");
        const [picture] = await saveDesignAsPictures(slug, design, kit, {
          jpeg: false,
          title: `Banner: ${designTitle(design, "email")}`,
          banner: true,
        });
        if (!/^https:\/\//.test(picture.url)) {
          throw new Error("The picture was saved, but its address can't be used in an email.");
        }
        return picture.url;
      },
      checkLinks: async () => ({
        unavailable:
          "Checking links live isn't switched on yet. Open each link once before you send.",
      }),
      canKeepShared,
      brandName,
      swatches,
      starters,
    }),
    [slug, id, logos, kit, canKeepShared, brandName, swatches, starters],
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
