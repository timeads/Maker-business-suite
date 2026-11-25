import Link from "next/link";
import { SiteFooter, SiteHeader } from "@/components/site/site-chrome";
import { BLANKS, longDate, type LegalFacts } from "@/lib/site/legal";

/** The frame the privacy policy and the terms share: the site's chrome, a title, a contents list. */
export function LegalPage({
  title,
  lead,
  facts,
  sections,
  children,
}: {
  title: string;
  lead: React.ReactNode;
  facts: LegalFacts;
  sections: { id: string; title: string }[];
  children: React.ReactNode;
}) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-12 sm:px-6">
        <div className="flex flex-col gap-3">
          <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm">
            In effect from{" "}
            {facts.effectiveDate ? (
              <time dateTime={facts.effectiveDate}>{longDate(facts.effectiveDate)}</time>
            ) : (
              <Blank>{BLANKS.effectiveDate}</Blank>
            )}
          </p>
          <p className="font-read text-lg">{lead}</p>
        </div>
        <nav aria-label="On this page" className="border-border rounded-md border px-4 py-3">
          <ol className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            {sections.map((section, index) => (
              <li key={section.id}>
                <a href={`#${section.id}`} className="hover:text-foreground text-text-2 underline">
                  {index + 1}. {section.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
        <div className="font-read flex flex-col gap-10">{children}</div>
        <p className="text-muted-foreground text-sm">
          See also the{" "}
          <Link href="/privacy" className="underline">
            privacy policy
          </Link>{" "}
          and the{" "}
          <Link href="/terms" className="underline">
            terms of service
          </Link>
          .
        </p>
      </main>
      <SiteFooter />
    </>
  );
}

/** One numbered part of a policy. The number comes from its place in the page's list. */
export function LegalSection({
  id,
  number,
  title,
  children,
}: {
  id: string;
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex scroll-mt-6 flex-col gap-3">
      <h2 id={id} className="font-sans text-xl font-semibold tracking-tight">
        {number}. {title}
      </h2>
      {children}
    </section>
  );
}

/** A fact the owner hasn't filled in yet, shown plainly rather than guessed. */
export function Blank({ children }: { children: React.ReactNode }) {
  return <span className="bg-ochre-soft rounded px-1 py-0.5 text-sm">[{children}]</span>;
}

export function Bullets({ children }: { children: React.ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5">{children}</ul>;
}

/** The contact line both pages end on: the address from the environment, or a plain blank. */
export function ContactLine({ facts }: { facts: LegalFacts }) {
  return (
    <p>
      Write to{" "}
      {facts.email ? (
        <a href={`mailto:${facts.email}`} className="underline">
          {facts.email}
        </a>
      ) : (
        <Blank>{BLANKS.email}</Blank>
      )}
      {" or by post to "}
      {facts.name ?? <Blank>{BLANKS.name}</Blank>},{" "}
      {facts.address ?? <Blank>{BLANKS.address}</Blank>}.
    </p>
  );
}
