import { splitSections } from "@/lib/helpdesk/manual/sections";
import type { RichDoc, RichRun } from "@/lib/helpdesk/rich";

/**
 * A topic or article drawn from its small document as React nodes: headings,
 * paragraphs, lists. Never as HTML, whoever wrote it.
 */
function Run({ run }: { run: RichRun }) {
  let node: React.ReactNode = run.text;
  if (run.b) node = <strong>{node}</strong>;
  if (run.i) node = <em>{node}</em>;
  if (run.u) node = <u>{node}</u>;
  if (run.s) node = <s>{node}</s>;
  if (run.href) {
    node = (
      <a
        href={run.href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-ochre-text underline"
      >
        {node}
      </a>
    );
  }
  return <>{node}</>;
}

const runs = (list: RichRun[]) => list.map((run, i) => <Run key={i} run={run} />);

export function DocView({ doc }: { doc: RichDoc }) {
  if (doc.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing written here yet.</p>;
  }
  return (
    <div className="font-read flex max-w-prose flex-col gap-5 text-[15px] leading-relaxed break-words">
      {splitSections(doc).map((section, at) => (
        <section key={at} className="flex flex-col gap-2">
          {section.heading !== null && (
            <h3 className="font-sans text-sm font-bold tracking-[-0.005em]">{section.heading}</h3>
          )}
          {section.blocks.map((block, i) =>
            block.t === "p" ? (
              <p key={i} className="whitespace-pre-wrap">
                {runs(block.runs)}
              </p>
            ) : block.t === "ul" ? (
              <ul key={i} className="flex list-disc flex-col gap-1 pl-5">
                {block.items.map((item, n) => (
                  <li key={n}>{runs(item)}</li>
                ))}
              </ul>
            ) : (
              <ol key={i} className="flex list-decimal flex-col gap-1 pl-5">
                {block.items.map((item, n) => (
                  <li key={n}>{runs(item)}</li>
                ))}
              </ol>
            ),
          )}
        </section>
      ))}
    </div>
  );
}
