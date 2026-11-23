"use client";

import { createContext, useContext } from "react";
import type { EmailDoc, EmailTemplate, LinkResult, SavedSection } from "@/lib/design";

/**
 * Everything the builder needs from the app around it: where an email is kept, the workspace's
 * saved sections, templates, photos and logos, and the server's link check. The builder itself
 * knows nothing about the database or who is signed in.
 */
export type BuilderHost = {
  /** Where "back"/"exit" goes. Use next/navigation's router.push(exitHref). */
  exitHref: string;
  save(doc: EmailDoc): Promise<void>;
  loadSavedSections(): Promise<SavedSection[]>;
  storeSavedSections(list: SavedSection[]): Promise<void>;
  loadTemplates(): Promise<EmailTemplate[]>;
  storeTemplates(list: EmailTemplate[]): Promise<void>;
  /** The workspace's library photos, for the photo picker. */
  listPhotos(): Promise<{ id: string; url: string; title: string }[]>;
  logos: { badge: string | null; dark: string | null; light: string | null };
  checkLinks(urls: string[]): Promise<{ results: LinkResult[] } | { unavailable: string }>;
  /** False when the person may not keep shared sections/templates; hide those save actions then. */
  canKeepShared: boolean;
  /** The workspace's brand: its name, its colours for the swatches, and its starter templates. */
  brandName: string;
  swatches: { name: string; hex: string }[];
  starters: EmailTemplate[];
};

export const HostContext = createContext<BuilderHost | null>(null);

export function useHost(): BuilderHost {
  const host = useContext(HostContext);
  if (!host) throw new Error("useHost is used outside the email builder");
  return host;
}
