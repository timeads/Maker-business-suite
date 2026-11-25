/*
 * DRAFT — NOT LEGAL ADVICE. Plain-language terms written to match how the
 * suite really works (trial, plans, read-only after a plan ends, deletion,
 * connected services, AI drafts). It has not been reviewed by a lawyer. The
 * parts that are legal judgement rather than description of the product —
 * above all "What we promise and what we don't" (warranty and liability),
 * "If something goes wrong between us" (governing law, disputes) and the
 * refund wording — are placeholders for a lawyer to settle. Fill in the
 * blanks (business name, address, contact address, governing law, effective
 * date) through the NEXT_PUBLIC_LEGAL_* and NEXT_PUBLIC_CONTACT_EMAIL
 * variables in .env.example; nothing about who runs the suite belongs in
 * this file.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Blank, Bullets, ContactLine, LegalPage, LegalSection } from "@/components/site/legal-page";
import { RETENTION_DAYS, TRIAL_DAYS } from "@/lib/billing/plans";
import { BLANKS, legalFacts } from "@/lib/site/legal";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The rules for using the Maker Business Suite, in plain words.",
};

const SECTIONS = [
  { id: "agreement", title: "The agreement" },
  { id: "accounts", title: "Accounts, workspaces and your team" },
  { id: "plans", title: "Trial, plans and paying" },
  { id: "yours", title: "What is yours" },
  { id: "customers", title: "Your customers' information" },
  { id: "connections", title: "Accounts you connect" },
  { id: "ai", title: "Drafts written by Claude" },
  { id: "use", title: "Using it fairly" },
  { id: "changes", title: "Changes to the suite" },
  { id: "ending", title: "Ending" },
  { id: "promises", title: "What we promise and what we don't" },
  { id: "law", title: "If something goes wrong between us" },
  { id: "contact", title: "Changes to these terms and how to reach us" },
] as const;

export default function TermsPage() {
  const facts = legalFacts();
  const us = facts.name ?? <Blank>{BLANKS.name}</Blank>;
  const n = (id: (typeof SECTIONS)[number]["id"]) => ({
    id,
    number: SECTIONS.findIndex((section) => section.id === id) + 1,
    title: SECTIONS.find((section) => section.id === id)!.title,
  });

  return (
    <LegalPage
      title="Terms of service"
      facts={facts}
      sections={[...SECTIONS]}
      lead="These are the rules for using the Maker Business Suite. We have kept them short and in plain words."
    >
      <LegalSection {...n("agreement")}>
        <p>
          The Maker Business Suite (“the suite”) is provided by {us} (“we”, “us”). By creating a
          workspace or using one you were invited to, you agree to these terms and to the{" "}
          <Link href="/privacy" className="underline">
            privacy policy
          </Link>
          . If you use the suite for a business, you agree on that business&apos;s behalf and
          confirm you are allowed to.
        </p>
      </LegalSection>

      <LegalSection {...n("accounts")}>
        <Bullets>
          <li>
            You sign in with a link sent to your email address or with Google. Keep your email
            account secure: whoever controls it can sign in as you.
          </li>
          <li>
            A workspace belongs to the business that created it. Its owners decide who is on the
            team and what each person may do, and are responsible for what their team does in it.
          </li>
          <li>
            The suite is for businesses. You must be old enough to enter a contract where you live.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("plans")}>
        <Bullets>
          <li>
            Every plan starts with {TRIAL_DAYS} days free. Prices and what each plan includes are on
            the{" "}
            <Link href="/pricing" className="underline">
              pricing page
            </Link>
            .
          </li>
          <li>
            Plans are paid monthly in advance through Stripe and renew until cancelled. You can
            change or cancel a plan at any time from Settings → Billing; a cancelled plan runs to
            the end of the period already paid for.
          </li>
          <li>
            Some features have monthly allowances (for example, drafts written by Claude). When an
            allowance is used up the feature pauses until the next month or a bigger plan.
          </li>
          <li>
            When a plan ends, the workspace becomes read-only: you can still see your records but
            not change them. {RETENTION_DAYS} days later the workspace and everything in it is
            deleted, unless you pick a plan again first.
          </li>
          <li>
            Payments already made are not refunded except where the law requires it or we agree
            otherwise.
          </li>
          <li>
            Postage you buy through a carrier or label service you connected, and payments your
            customers make to your own Stripe account, are between you and those services. We are
            not a party to them.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("yours")}>
        <p>
          Everything you and your team put into the suite, and everything it reads from the accounts
          you connect, stays yours. You give us permission to store it, process it and show it to
          your team so the suite can do its job, and for nothing else. We do not sell it, and we do
          not use it to train AI models.
        </p>
        <p>
          The suite itself (its software, design and name) is ours. These terms let you use it; they
          do not transfer it to you.
        </p>
      </LegalSection>

      <LegalSection {...n("customers")}>
        <p>
          The suite holds information about your own customers: their emails and messages, orders,
          delivery addresses and bookings. For that information you are the one responsible to your
          customers, and we handle it only on your instructions, as the{" "}
          <Link href="/privacy" className="underline">
            privacy policy
          </Link>{" "}
          describes. That means:
        </p>
        <Bullets>
          <li>
            You need a lawful reason to hold it and must tell your customers how you use it (your
            own privacy notice).
          </li>
          <li>
            When a customer asks you to see or delete their information, you answer them. The suite
            gives you the tools (“Forget this customer”, your shop&apos;s privacy requests), and we
            will help if you ask.
          </li>
          <li>
            Don&apos;t put information into the suite that it isn&apos;t meant for, such as payment
            card numbers or health records.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("connections")}>
        <p>
          The suite works by connecting to accounts you already have: your shop, your accounting,
          your Facebook Page and Instagram account, your Gmail, your Stripe account, your carriers.
          When you connect one:
        </p>
        <Bullets>
          <li>
            You confirm the account is yours or you are allowed to connect it, and you let the suite
            act in it within the permissions you granted.
          </li>
          <li>
            That service&apos;s own terms and rules still apply to you. For example, Instagram and
            Facebook only allow a reply to a message within a set time, and their rules about what
            may be posted or sent are theirs to enforce.
          </li>
          <li>
            Those services are not ours. They can change, limit or withdraw what they let the suite
            do, and a feature that depends on them may stop working if they do.
          </li>
          <li>You can disconnect an account at any time under Connections.</li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("ai")}>
        <p>
          Some features ask Claude, an AI model made by Anthropic, to write a draft, a summary or a
          suggestion. A draft is a starting point: it can be wrong. Nothing Claude writes is sent to
          your customers, posted or published by itself. A person on your team reads it and decides,
          and what you send is your responsibility. The privacy policy says what is sent to
          Anthropic and when.
        </p>
      </LegalSection>

      <LegalSection {...n("use")}>
        <p>Please don&apos;t:</p>
        <Bullets>
          <li>use the suite to break the law, or to send spam or anything deceptive or abusive;</li>
          <li>
            publish through it (help articles, link pages, booking pages, posts) anything you
            don&apos;t have the right to publish;
          </li>
          <li>
            try to get into another workspace&apos;s records, or probe or overload the service;
          </li>
          <li>resell the suite or let people outside your business use your workspace.</li>
        </Bullets>
        <p>
          If a workspace is used in a way that harms other people or the service, we may suspend it.
          Unless it is urgent, we will tell its owner first and give them a chance to put it right.
        </p>
      </LegalSection>

      <LegalSection {...n("changes")}>
        <p>
          We keep improving the suite, so tools and screens change. We may add, change or retire a
          feature. If we retire something you rely on, we will give reasonable notice where we can.
          The suite may be unavailable now and then for maintenance or because of problems at the
          services it runs on.
        </p>
      </LegalSection>

      <LegalSection {...n("ending")}>
        <Bullets>
          <li>
            You can stop at any time by cancelling your plan. What happens to your records then is
            described under “Trial, plans and paying”.
          </li>
          <li>
            We may end a workspace&apos;s access if these terms are seriously or repeatedly broken,
            or if a plan stays unpaid.
          </li>
          <li>
            If you want your workspace deleted before the {RETENTION_DAYS} days are up, write to us.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("promises")}>
        <p>
          We will provide the suite with reasonable care and skill. Beyond that, and as far as the
          law allows, it is provided as it is: we do not promise it will be uninterrupted or free of
          mistakes, or that its figures, suggested orders, prices or drafts are right for your
          business. Check anything that matters before you act on it.
        </p>
        <p>
          As far as the law allows, we are not liable for lost profits, lost business or indirect
          losses, and our total liability to you for everything connected with the suite is limited
          to what you paid us for it in the twelve months before the claim arose. Nothing in these
          terms limits liability that cannot be limited by law.
        </p>
      </LegalSection>

      <LegalSection {...n("law")}>
        <p>
          If you are unhappy with something, tell us first; most things can be put right by talking.
          These terms are governed by the laws of{" "}
          {facts.governingLaw ?? <Blank>{BLANKS.governingLaw}</Blank>}, and disputes go to the
          courts there, unless the law where you live gives you the right to go elsewhere.
        </p>
      </LegalSection>

      <LegalSection {...n("contact")}>
        <p>
          If these terms change, the new wording is published here with the date it takes effect at
          the top of the page. If you keep using the suite after that date, you accept the new
          terms.
        </p>
        <ContactLine facts={facts} />
      </LegalSection>
    </LegalPage>
  );
}
