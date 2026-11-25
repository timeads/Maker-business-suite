import { isPublicLink, type PlacedSection } from "@/lib/helpdesk/help-centre/public";
import type { RichRun } from "@/lib/helpdesk/rich";

/**
 * A published article drawn from its small document as React nodes:
 * headings, paragraphs, lists, https links and the article's own pictures.
 * Every word is a text node; no markup from anyone is ever rendered.
 */
function Run({ run }: { run: RichRun }) {
  let node: React.ReactNode = run.text;
  if (run.b) node = <strong>{node}</strong>;
  if (run.i) node = <em>{node}</em>;
  if (run.u) node = <u>{node}</u>;
  if (run.s) node = <s>{node}</s>;
  if (isPublicLink(run.href)) {
    node = (
      <a href={run.href} rel="nofollow noopener" className="text-ochre-text underline">
        {node}
      </a>
    );
  }
  return <>{node}</>;
}

const runs = (list: RichRun[]) => list.map((run, i) => <Run key={i} run={run} />);

export function PublicDoc({ sections }: { sections: PlacedSection[] }) {
  return (
    <div className="font-read flex flex-col gap-8 text-[17px] leading-relaxed break-words">
      {sections.map((section, at) => (
        <section key={at} className="flex flex-col gap-3">
          {section.heading !== null && (
            <h2 className="font-sans text-xl font-bold tracking-[-0.01em] text-balance">
              {section.heading}
            </h2>
          )}
          {section.blocks.map((block, i) =>
            block.t === "p" ? (
              <p key={i} className="whitespace-pre-wrap">
                {runs(block.runs)}
              </p>
            ) : block.t === "ul" ? (
              <ul key={i} className="flex list-disc flex-col gap-1.5 pl-6">
                {block.items.map((item, n) => (
                  <li key={n}>{runs(item)}</li>
                ))}
              </ul>
            ) : (
              <ol key={i} className="flex list-decimal flex-col gap-1.5 pl-6">
                {block.items.map((item, n) => (
                  <li key={n}>{runs(item)}</li>
                ))}
              </ol>
            ),
          )}
          {section.pictures.map((picture) => (
            <figure key={picture.url} className="flex flex-col gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- the article's own picture, on our storage */}
              <img
                src={picture.url}
                alt={picture.alt}
                loading="lazy"
                className="border-border bg-card max-h-[520px] w-full rounded-lg border object-contain"
              />
              {picture.caption && (
                <figcaption className="text-text-2 text-sm">{picture.caption}</figcaption>
              )}
            </figure>
          ))}
        </section>
      ))}
    </div>
  );
}
