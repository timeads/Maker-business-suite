import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicLinkPage } from "@/lib/social/links-server";

export const metadata: Metadata = { title: "Links", robots: { index: false } };

/** A business's page of links, for the one link a social profile allows. */
export default async function PublicLinksPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!process.env.SUPABASE_SECRET_KEY) notFound();
  const found = await getPublicLinkPage(slug);
  if (!found) notFound();
  const { name, page, photos } = found;

  return (
    <main className="bg-panel min-h-dvh px-4 py-12">
      <div className="mx-auto flex w-full max-w-md flex-col gap-8">
        <header className="flex flex-col items-center gap-2 text-center">
          <h1 className="text-2xl leading-tight font-bold tracking-[-0.015em] text-balance">
            {page.heading || name}
          </h1>
          {page.intro && <p className="text-text-2 font-read text-sm">{page.intro}</p>}
        </header>
        <ul className="flex flex-col gap-3">
          {page.links.map((link) => (
            <li key={link.id}>
              <a
                href={link.url}
                rel="noopener"
                className="bg-card border-border hover:border-ochre focus-visible:ring-ochre block rounded-lg border px-5 py-4 text-center font-semibold transition-colors duration-150 outline-none focus-visible:ring-2"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
        {photos.length > 0 && (
          <ul className="grid grid-cols-3 gap-1.5">
            {photos.map((url) => (
              <li key={url}>
                {/* eslint-disable-next-line @next/next/no-img-element -- a user upload on another host */}
                <img
                  src={url}
                  alt={`A recent photo from ${name}`}
                  loading="lazy"
                  className="aspect-square w-full rounded-md object-cover"
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}
