/*
 * DRAFT — NOT LEGAL ADVICE. This page was written from what the code does
 * (the migrations, the worker and CLAUDE.md), to give the owner something
 * accurate to take to a lawyer. It has not been reviewed by one. Before the
 * suite is offered to anyone outside the owner's own business, have it
 * reviewed, and fill in the blanks (business name, address, contact address,
 * effective date) through the NEXT_PUBLIC_LEGAL_* and NEXT_PUBLIC_CONTACT_EMAIL
 * variables in .env.example. Nothing about who runs the suite belongs in this
 * file.
 *
 * When the app changes what it stores, who it sends data to, or when it calls
 * Claude, change this page in the same commit.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Blank, Bullets, ContactLine, LegalPage, LegalSection } from "@/components/site/legal-page";
import { RETENTION_DAYS } from "@/lib/billing/plans";
import { BLANKS, legalFacts } from "@/lib/site/legal";

export const metadata: Metadata = {
  title: "Privacy policy",
  description:
    "What the Maker Business Suite keeps, where it is kept, who it is shared with, and how to have it deleted.",
};

const SECTIONS = [
  { id: "who", title: "Who we are and what this covers" },
  { id: "you", title: "What we keep about you and your workspace" },
  { id: "customers", title: "What a workspace keeps about its own customers" },
  { id: "where", title: "Where it is kept" },
  { id: "services", title: "Other companies involved" },
  { id: "ai", title: "When Claude is used" },
  { id: "meta", title: "Facebook and Instagram data" },
  { id: "google", title: "Google user data" },
  { id: "keeping", title: "How long things are kept" },
  { id: "deleting", title: "Deleting data and forgetting a customer" },
  { id: "cookies", title: "Cookies and your browser" },
  { id: "security", title: "Keeping it safe" },
  { id: "rights", title: "Your choices" },
  { id: "contact", title: "Changes and how to reach us" },
] as const;

export default function PrivacyPage() {
  const facts = legalFacts();
  const us = facts.name ?? <Blank>{BLANKS.name}</Blank>;
  const n = (id: (typeof SECTIONS)[number]["id"]) => ({
    id,
    number: SECTIONS.findIndex((section) => section.id === id) + 1,
    title: SECTIONS.find((section) => section.id === id)!.title,
  });

  return (
    <LegalPage
      title="Privacy policy"
      facts={facts}
      sections={[...SECTIONS]}
      lead="The Maker Business Suite is a set of back-office tools for small maker businesses. This page says, in plain words, what it keeps, where, who else is involved, and how to have something deleted."
    >
      <LegalSection {...n("who")}>
        <p>
          The Maker Business Suite (“the suite”) is run by {us}. A business that signs up gets a{" "}
          <strong>workspace</strong>; the people it invites are its <strong>team</strong>.
        </p>
        <p>There are two kinds of information here, and we stand differently towards each:</p>
        <Bullets>
          <li>
            <strong>About you as someone who uses the suite</strong> (your sign-in, your workspace,
            your plan). We decide how that is handled, and this policy describes it.
          </li>
          <li>
            <strong>About a workspace&apos;s own customers</strong> (the people who email it, buy
            from it, book with it or message it). That belongs to the business. We hold it on the
            business&apos;s behalf and only to run the tools it has switched on. If you are a
            customer of a business that uses the suite, the business is the one to ask first; we
            help it answer.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("you")}>
        <Bullets>
          <li>
            <strong>Your sign-in.</strong> Your email address. You sign in with a link we email you
            or with Google; there is no password. With Google we receive your email address and the
            basic profile Google shares for sign-in.
          </li>
          <li>
            <strong>Your workspace.</strong> Its name, web address, time zone and currency; who is
            on the team and their roles; invitations (the invited email address, and a scrambled
            form of the invite code); and the settings each tool is given.
          </li>
          <li>
            <strong>Your plan.</strong> Which plan the workspace is on and its state. Card details
            are typed into Stripe&apos;s pages and never reach us.
          </li>
          <li>
            <strong>What your team writes.</strong> Team chat messages, notes on conversations,
            reply templates, help articles, posts and captions, email designs, and the photos and
            videos you upload.
          </li>
          <li>
            <strong>Connections.</strong> When you connect a shop, an accounting package, a Page, a
            mailbox or a carrier, we keep the access it gives us (encrypted, see “Keeping it safe”),
            the account&apos;s name and which permissions were granted.
          </li>
          <li>
            <strong>A record of changes.</strong> An audit log of important actions in a workspace
            (who changed a setting, that a customer was forgotten), and earlier versions of settings
            so a change can be undone.
          </li>
        </Bullets>
        <p>
          We do not run advertising or analytics trackers on the site or in the app, and we do not
          sell anyone&apos;s information.
        </p>
      </LegalSection>

      <LegalSection {...n("customers")}>
        <p>
          What is held depends on which tools a workspace uses and what it has connected. Nothing
          below is collected unless the business switched that tool or connection on.
        </p>
        <Bullets>
          <li>
            <strong>Help desk.</strong> Emails sent to the workspace&apos;s support address: the
            sender&apos;s name and email address, who else the email went to, the subject, the
            plain-text body, and attached pictures and files of the kinds the help desk keeps
            (pictures, PDFs, short videos, sound, plain text). Replies the team sends. With
            Instagram or Facebook switched on: the person&apos;s id as Meta gives it to that Page or
            Instagram account, their name and, on Instagram, their @handle; what they wrote and the
            files they sent. Never a profile picture. See “Facebook and Instagram data”.
          </li>
          <li>
            <strong>Money and the shop sync.</strong> From a connected shop: orders (totals, dates,
            status), products, and customers&apos; names and email addresses. From connected
            accounting: report figures and, if switched on, payments to suppliers.
          </li>
          <li>
            <strong>Shipping.</strong> For orders waiting to be sent: the recipient&apos;s name,
            delivery address, phone number and email address, what is in the order, and the labels
            and tracking numbers of parcels. These are kept apart from the sales figures.
          </li>
          <li>
            <strong>Bookings.</strong> The name and email address typed into a booking, how many
            seats, answers to any questions the business asks, and the state of the payment. Card
            details go to Stripe on the business&apos;s own Stripe account, not to us.
          </li>
          <li>
            <strong>Stock.</strong> Products, counts, suppliers, purchase orders and what is owed to
            suppliers. This is about the business and its suppliers, not shoppers. With “bills by
            email”, only the facts read from a supplier&apos;s bill are kept (who, how much, when
            due), not the email&apos;s text or files.
          </li>
          <li>
            <strong>Marketplace listings.</strong> For a connected Michaels seller account: listings
            and order totals. Nothing about the buyer is kept.
          </li>
          <li>
            <strong>Social.</strong> The business&apos;s own posts, captions, photos and videos.
            Nothing about its followers.
          </li>
          <li>
            <strong>The public help centre.</strong> Visitors are not identified. To stop abuse of
            search and “Was this helpful?”, a short-lived scrambled fingerprint is counted; no
            address is stored and no cookie is set.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("where")}>
        <Bullets>
          <li>
            <strong>The database and sign-in</strong> are hosted by Supabase (Postgres). Every
            record carries the workspace it belongs to, and the database itself refuses to show one
            workspace&apos;s records to another.
          </li>
          <li>
            <strong>Files</strong> are in Supabase Storage. Help desk attachments are in a private
            store and are only ever handed out through the app to a signed-in member of that
            workspace. Photos and videos a business uploads for posting, and the pictures in its
            published help articles, are in public stores, because Instagram and visitors must be
            able to fetch them by address.
          </li>
          <li>
            <strong>The application</strong> (the website and the background worker) runs on
            Railway.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("services")}>
        <p>These companies handle information for us so the suite can run:</p>
        <Bullets>
          <li>
            <strong>Supabase</strong>: database, sign-in and file storage.
          </li>
          <li>
            <strong>Railway</strong>: runs the application.
          </li>
          <li>
            <strong>Stripe</strong>: takes payment for plans. For Bookings, a business connects its
            own Stripe account and its customers pay that account directly.
          </li>
          <li>
            <strong>Postmark</strong>: receives email sent to a workspace&apos;s support and bills
            addresses, and sends the help desk&apos;s replies, booking emails and invitations.
          </li>
          <li>
            <strong>Anthropic</strong> (Claude): drafts and summaries, as set out in “When Claude is
            used”.
          </li>
          <li>
            <strong>Google</strong>: “Continue with Google” sign-in.
          </li>
        </Bullets>
        <p>
          And these are services a business may choose to connect. Information moves between the
          suite and them only once the business connects its own account, and only for that
          workspace:
        </p>
        <Bullets>
          <li>
            <strong>Shopify</strong>: orders, products, customers and stock counts are read; the
            suite can mark a parcel as sent and add received stock where the business allowed it.
          </li>
          <li>
            <strong>Intuit QuickBooks</strong>: report figures are read.
          </li>
          <li>
            <strong>Meta</strong> (Facebook and Instagram): see the section below.
          </li>
          <li>
            <strong>Google Gmail</strong>: see “Google user data”.
          </li>
          <li>
            <strong>UPS, EasyPost and Redo</strong>: to price and buy a shipping label, the
            sender&apos;s and recipient&apos;s names and addresses and the parcel&apos;s size and
            weight are sent to the service the business chose. UPS is also asked where incoming
            supplier parcels are.
          </li>
          <li>
            <strong>Michaels</strong>: the seller account&apos;s listings and orders are read.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("ai")}>
        <p>
          Some features use Claude, an AI model made by Anthropic, through Anthropic&apos;s API.
          Text is sent to Anthropic only in the cases below. Nothing Claude writes is sent to a
          customer or published by itself: a person reads it and decides.
        </p>
        <Bullets>
          <li>
            <strong>When a person presses a button.</strong> “Draft a reply” and “Summarize” in the
            help desk send that conversation&apos;s messages (attachments by name and kind only),
            with any matching help articles and the workspace&apos;s brand notes. Caption, email and
            month-plan drafts send the brief the person typed and the brand notes. The brand kit
            helper sends the answers typed in or the guide uploaded. “Draft a help article” sends
            the topic it is made from. The assistant sends the question asked and what its tools
            looked up in that workspace to answer it.
          </li>
          <li>
            <strong>When a workspace has switched a feature on.</strong> The help desk manual, if
            its automatic runs are on (or when a manager asks for a run), reads finished
            conversations to write up topics. Before anything is sent, email addresses, street
            addresses, phone, order and tracking numbers and the customer&apos;s name are taken out
            by the suite; up to three of the customer&apos;s photos may be included, never a video.
            Bills by email, once set up, sends supplier emails that were forwarded to the
            workspace&apos;s bills address, found in its connected Gmail from the senders it named,
            or uploaded, so the amounts and dates can be read.
          </li>
        </Bullets>
        <p>
          We do not use anyone&apos;s information to train AI models. How Anthropic handles what it
          receives through its API is described in Anthropic&apos;s own terms and privacy policy.
          Each plan has a monthly allowance for these features, and a workspace can leave them
          unused.
        </p>
      </LegalSection>

      <LegalSection {...n("meta")}>
        <p>
          A business can connect its Facebook Page and the Instagram professional account linked to
          it, using Facebook Login. Each kind of access is asked for only when the business switches
          that feature on, and we record which permissions Facebook actually granted.
        </p>
        <Bullets>
          <li>
            <strong>What we receive.</strong> The Page&apos;s name and id, the linked Instagram
            account&apos;s id and username, and an access token for the Page. For posting: nothing
            more. For messages in the help desk: messages sent to the Page or Instagram account, the
            sender&apos;s id as Meta scopes it to that Page or account, their name and Instagram
            @handle, and photos, videos and voice messages they send.
          </li>
          <li>
            <strong>What we do with it.</strong> Publish the posts the business scheduled; show its
            team the messages it received so they can answer; send the team&apos;s replies. Nothing
            else. It is not used for advertising, not combined across workspaces, not sold and not
            shared with anyone except the companies listed above that store and run the suite.
          </li>
          <li>
            <strong>What we do not take.</strong> Profile pictures, follower lists, or the content
            of stories and posts that someone shares in a message (only a note that one was shared).
          </li>
          <li>
            <strong>How long.</strong> Until the business deletes the conversation or forgets the
            person, disconnects, or its workspace is deleted (see below). A message the sender takes
            back on Instagram or Facebook is removed here as well, words and files.
          </li>
          <li>
            <strong>Disconnecting.</strong> Disconnecting Facebook &amp; Instagram in the workspace
            asks Meta to stop sending and withdraws the permission. You can also remove the app from
            your Facebook settings under Business integrations.
          </li>
          <li>
            <strong>Asking for deletion.</strong> If you messaged a business that uses the suite and
            want your messages deleted, ask that business, or write to us at the address at the end
            of this page with the name of the business and your Instagram or Facebook name; the
            business&apos;s owner can delete you and every conversation with you in one step. We
            also answer Meta&apos;s data deletion requests automatically: when Facebook sends one,
            whatever is held under that id is deleted, and Facebook gives you a link that shows when
            it is done.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("google")}>
        <p>The suite uses Google in two separate ways.</p>
        <Bullets>
          <li>
            <strong>Signing in with Google.</strong> We receive your email address and basic
            profile, and use them only to sign you in.
          </li>
          <li>
            <strong>Connecting Gmail (optional, for Stock).</strong> A business can connect its own
            Gmail so purchase orders are emailed to suppliers from its own address. That asks for
            permission to <em>send</em> email only: with it the suite cannot read a single message.
            An order is sent only when a manager presses send after a preview; we keep when it was
            sent, by whom, to whom, and Gmail&apos;s id for the message.
          </li>
          <li>
            <strong>Reading bills from Gmail (optional, asked for separately).</strong> If the
            business also turns on the daily look for supplier bills, it is asked for read-only
            access to Gmail. The suite then searches only for mail from the senders and subjects the
            business listed, checks the sender again on each message, and passes those messages to
            Claude (see “When Claude is used”) to read the amounts and dates. The message&apos;s
            text and attachments are not stored: only its id, sender, subject and the facts read
            from it.
          </li>
        </Bullets>
        <p>
          The suite&apos;s use and transfer to any other app of information received from Google
          APIs will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            className="underline"
            rel="noreferrer"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements. In particular: Gmail data is used only to
          provide the features described here; it is not used for advertising; it is not used to
          develop or train generalised AI or machine-learning models; it is not sold; and no person
          at {us} reads it unless the business asks us to for support, it is needed for security or
          to comply with the law.
        </p>
        <p>
          Access can be withdrawn at any time by disconnecting Gmail in the workspace, or in your
          Google Account under “Third-party apps and services”.
        </p>
      </LegalSection>

      <LegalSection {...n("keeping")}>
        <p>
          A workspace&apos;s records are kept for as long as the workspace is open, so the business
          has its history, except where the app removes things sooner:
        </p>
        <Bullets>
          <li>
            When a plan ends the workspace becomes read-only, and it is deleted with everything in
            it {RETENTION_DAYS} days later unless a plan is picked again.
          </li>
          <li>
            Deliveries from Meta and incoming emails are held in a queue only until they have been
            filed; a finished delivery&apos;s contents are cleared from the queue.
          </li>
          <li>
            An attachment&apos;s file is removed from storage when its message, conversation or
            customer is deleted.
          </li>
          <li>
            Daily stock counts are kept for about 200 days; records of bill emails that were read
            (ids and facts, never the text) for about 400 days; finished run logs for 60 to 120
            days; the help centre&apos;s abuse counters for 2 days.
          </li>
          <li>
            A help desk conversation moved to the Trash stays there until a manager deletes it for
            good; nothing empties the Trash by itself.
          </li>
        </Bullets>
        <p>
          Backups made by our hosting provider may hold deleted records for a short time longer
          before they roll off.
        </p>
      </LegalSection>

      <LegalSection {...n("deleting")}>
        <Bullets>
          <li>
            <strong>A shopper of a connected shop.</strong> When the shop sends a privacy request to
            erase a customer, the suite deletes that customer&apos;s record, removes their name and
            email from their orders, blanks their delivery addresses, and deletes their help desk
            contact and conversations for that email address (including an Instagram or Facebook
            contact the team had noted that address for).
          </li>
          <li>
            <strong>Someone who messaged on Instagram or Facebook.</strong> An owner or admin opens
            the conversation and chooses “Forget this customer”: the person, every conversation with
            them, what was said and their files are deleted. The log records that it happened, not
            who it was.
          </li>
          <li>
            <strong>Meta&apos;s data deletion callback.</strong> Described under “Facebook and
            Instagram data”.
          </li>
          <li>
            <strong>Disconnecting a shop.</strong> Delivery addresses read from it are blanked.
          </li>
          <li>
            <strong>A whole workspace.</strong> Deleted {RETENTION_DAYS} days after its plan ends,
            or sooner if its owner asks us.
          </li>
          <li>
            <strong>Your own account.</strong> Write to us and we will delete it. If you are the
            only owner of a workspace, it has to be handed over or deleted first.
          </li>
        </Bullets>
      </LegalSection>

      <LegalSection {...n("cookies")}>
        <p>
          The suite sets only the cookies it needs to work. There are no advertising or analytics
          cookies, which is why there is no cookie banner.
        </p>
        <Bullets>
          <li>
            <strong>Sign-in cookies</strong> from Supabase, which keep you signed in.
          </li>
          <li>
            <strong>A short-lived cookie while you connect an account</strong> (a shop, a Page,
            Gmail), so the answer that comes back can be matched to your request.
          </li>
          <li>
            <strong>Two layout cookies</strong> (<code>mbs-panel</code>, <code>mbs-desk-rail</code>)
            that remember whether you folded a side panel.
          </li>
        </Bullets>
        <p>
          Some things are kept in your browser only and never sent to us: unsent help desk drafts,
          which label printer a computer uses, and a few display choices. Public pages (this one,
          pricing, help, a business&apos;s help centre, booking and link pages) set no cookie for a
          visitor who is not signed in.
        </p>
      </LegalSection>

      <LegalSection {...n("security")}>
        <Bullets>
          <li>
            Access tokens and keys for connected accounts are stored encrypted in a vault inside the
            database, are never shown in the app and are not written to logs.
          </li>
          <li>
            The database enforces that a workspace&apos;s records are only readable by its own team,
            and sensitive changes go through checked functions that confirm the person&apos;s role.
          </li>
          <li>
            Incoming webhooks (Stripe, Shopify, Meta, email) are verified before anything is
            accepted.
          </li>
          <li>
            Email and messages from customers are shown as plain text; files are accepted by what
            they really are, not by their name.
          </li>
          <li>
            The few people who run the suite can see how a workspace is running (its plan,
            connections and counts), not what its customers wrote or bought, and their actions are
            logged.
          </li>
        </Bullets>
        <p>
          No system is perfectly secure. If we learn of a breach that affects you, we will tell you.
        </p>
      </LegalSection>

      <LegalSection {...n("rights")}>
        <p>
          Depending on where you live, the law may give you the right to see, correct, export or
          delete information about you, or to object to how it is used. To use any of these, write
          to us. If your request is about a business that uses the suite, we will pass it to that
          business and help it respond.
        </p>
        <p>The suite is for businesses and is not meant for children.</p>
      </LegalSection>

      <LegalSection {...n("contact")}>
        <p>
          If this policy changes, the new wording is published here with the date it takes effect at
          the top of the page.
        </p>
        <ContactLine facts={facts} />
        <p>
          The rules for using the suite are in the{" "}
          <Link href="/terms" className="underline">
            terms of service
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
