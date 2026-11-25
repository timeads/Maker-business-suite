/**
 * Who runs this deployment of the suite, for the privacy policy and terms.
 * None of it lives in code: each fact comes from an environment variable, and
 * a fact that hasn't been filled in is shown on the page as a labelled blank,
 * never guessed. The variables are public (`NEXT_PUBLIC_…`) because they are
 * printed on public pages; they are read when the site is built, so redeploy
 * after changing one.
 */
export type LegalFacts = {
  /** The legal name of the business that runs the suite. */
  name: string | null;
  /** Its postal address, on one line. */
  address: string | null;
  /** Where privacy and legal questions go. */
  email: string | null;
  /** Whose law governs the terms, as the owner's lawyer words it ("the State of …"). */
  governingLaw: string | null;
  /** The day the current wording took effect, as an ISO date (2027-01-31). */
  effectiveDate: string | null;
};

const EMAIL = /^[^@\s<>",;]+@[^@\s<>",;]+\.[^@\s<>",;]+$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const line = (raw: string | undefined, max: number): string | null => {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  return text && text.length <= max ? text : null;
};

/** Reads the facts out of a set of variables. Anything missing or malformed is null. */
export function readLegalFacts(env: Record<string, string | undefined>): LegalFacts {
  const email = line(env.NEXT_PUBLIC_CONTACT_EMAIL, 254);
  const date = line(env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE, 10);
  const real =
    date !== null && ISO_DATE.test(date) && !Number.isNaN(Date.parse(`${date}T00:00:00Z`));
  return {
    name: line(env.NEXT_PUBLIC_LEGAL_NAME, 160),
    address: line(env.NEXT_PUBLIC_LEGAL_ADDRESS, 300),
    email: email && EMAIL.test(email) ? email.toLowerCase() : null,
    governingLaw: line(env.NEXT_PUBLIC_LEGAL_GOVERNING_LAW, 160),
    effectiveDate: real ? date : null,
  };
}

/** This deployment's facts. Each variable is named in full so the build can see it. */
export const legalFacts = (): LegalFacts =>
  readLegalFacts({
    NEXT_PUBLIC_LEGAL_NAME: process.env.NEXT_PUBLIC_LEGAL_NAME,
    NEXT_PUBLIC_LEGAL_ADDRESS: process.env.NEXT_PUBLIC_LEGAL_ADDRESS,
    NEXT_PUBLIC_CONTACT_EMAIL: process.env.NEXT_PUBLIC_CONTACT_EMAIL,
    NEXT_PUBLIC_LEGAL_GOVERNING_LAW: process.env.NEXT_PUBLIC_LEGAL_GOVERNING_LAW,
    NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE: process.env.NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE,
  });

/** "January 31, 2027" for an ISO date, with no timezone drift. */
export function longDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00Z`));
}

/** What a page prints where a fact hasn't been filled in yet. */
export const BLANKS = {
  name: "business name not set",
  address: "business address not set",
  email: "contact address not set",
  governingLaw: "governing law not set",
  effectiveDate: "effective date not set",
} as const satisfies Record<keyof LegalFacts, string>;

/** The facts still missing, by name: for the page's own note and for tests. */
export const missingFacts = (facts: LegalFacts): (keyof LegalFacts)[] =>
  (Object.keys(BLANKS) as (keyof LegalFacts)[]).filter((key) => facts[key] === null);
