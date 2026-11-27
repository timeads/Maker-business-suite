import type { SetupItem, SetupStep } from "../setup/items";

/**
 * "Finish setting up Social": what still stands between the workspace and
 * posts that go out in its own look, worked out on read
 * (docs/setup-pattern.md). Pure: the facts come from `setup-data.ts`.
 * Nothing is stored but a person's "Not now".
 *
 * Required: a brand kit for the main brand, somewhere to post (a Facebook
 * login with posting allowed and an account chosen, unless TikTok or
 * LinkedIn already carries the posts), and any account whose login has run
 * out. Optional: TikTok and LinkedIn (only where their keys are set), the
 * content plan, review, the monthly run, the link page and the logo. The
 * monthly run is only ever switched on by a person on its own form: an item
 * here explains and links, nothing more.
 */

export const SOCIAL_TOOL = "social";

export const SOCIAL_STEPS: readonly SetupStep[] = [
  { id: "brand", title: "Your brand" },
  { id: "accounts", title: "Where you post" },
  { id: "plan", title: "What you post about" },
  { id: "review", title: "Who checks posts" },
  { id: "extras", title: "Extras, if you'd like them" },
  { id: "done", title: "Have a look" },
];

export type SocialSetupFacts = {
  /** The main brand's kit was saved at least once. */
  kitSaved: boolean;
  /** The Facebook login (provider `meta`); null when never connected. */
  meta: {
    status: "active" | "needs_reconnect" | "disconnected";
    /** The login was granted posting, to a Page and to Instagram. */
    canPostFacebook: boolean;
    canPostInstagram: boolean;
  } | null;
  /** Facebook and Instagram accounts chosen to be in use. */
  metaAccounts: number;
  /** TikTok or LinkedIn accounts in use. */
  otherAccounts: number;
  /** Accounts in use whose login must be connected again. */
  needsLogin: { id: string; name: string }[];
  /** TikTok and LinkedIn: offered here (their keys are set), and connected. */
  tiktok: { offered: boolean; connected: boolean };
  linkedin: { offered: boolean; connected: boolean };
  plan: { topics: number; monthlyRunOn: boolean };
  review: { saved: boolean };
  links: { published: boolean };
  /** A picture tagged as the logo, the way emails and slips find it. Null when not known. */
  logo: boolean | null;
};

/** The open items, in the order the guided setup takes them. */
export function socialSetupItems(facts: SocialSetupFacts): SetupItem[] {
  const items: SetupItem[] = [];

  if (!facts.kitSaved) {
    items.push({
      id: "brand.kit",
      title: "Save your brand kit",
      why: "Drafts, emails and slides are written in your voice and drawn in your colours from it. Without one they come out plain.",
      to: "settings/brand",
      action: "Make your kit",
      facts: "never",
      step: "brand",
      managersOnly: true,
    });
  }

  const meta = facts.meta;
  const elsewhere = facts.otherAccounts > 0;
  if (meta?.status === "needs_reconnect") {
    items.push({
      id: "accounts.reconnect",
      title: "Facebook & Instagram need connecting again",
      why: "Scheduled posts can't go out to them until the connection is renewed.",
      to: "connections",
      action: "Connect again",
      facts: "reconnect",
      step: "accounts",
      managersOnly: true,
    });
  } else if (meta?.status === "active" && !meta.canPostFacebook && !meta.canPostInstagram) {
    items.push({
      id: "accounts.posting",
      title: "Allow posting on Facebook",
      why: "Facebook & Instagram is connected for the help desk, but wasn't given permission to publish. Drafts work now; scheduling needs that permission.",
      to: "social/setup#accounts",
      action: "Allow posting",
      facts: "no-posting",
      step: "accounts",
      managersOnly: true,
    });
  } else if (meta?.status === "active" && facts.metaAccounts === 0) {
    items.push({
      id: "accounts.choose",
      title: "Choose which Pages and Instagram accounts you post to",
      why: "Posts go only to the accounts you've chosen to use. None is chosen yet.",
      to: "settings/social/accounts",
      action: "Choose them",
      facts: "none",
      step: "accounts",
      managersOnly: true,
    });
  } else if ((!meta || meta.status === "disconnected") && !elsewhere) {
    items.push({
      id: "accounts.connect",
      title: "Connect your Facebook Page",
      why: "You can write drafts now. To schedule and publish them, connect the Page, and its Instagram account comes with it.",
      to: "connections",
      action: "Connect it",
      facts: "none",
      step: "accounts",
      managersOnly: true,
    });
  }
  if (facts.needsLogin.length > 0) {
    const n = facts.needsLogin.length;
    items.push({
      id: "accounts.login",
      title: `${n === 1 ? "An account needs" : `${n} accounts need`} logging in again`,
      why: "Its login ran out, so nothing can be posted to it until someone logs in again.",
      count: n,
      names: facts.needsLogin.map((a) => a.name),
      to: "settings/social/accounts",
      action: "Log in again",
      facts: facts.needsLogin
        .map((a) => a.id)
        .sort()
        .join(","),
      step: "accounts",
      managersOnly: true,
    });
  }

  // Optional from here on: offered on the guided page, never on the card.
  for (const [key, name] of [
    ["tiktok", "TikTok"],
    ["linkedin", "LinkedIn"],
  ] as const) {
    if (facts[key].offered && !facts[key].connected) {
      items.push({
        id: `accounts.${key}`,
        title: `Post to ${name} as well`,
        why:
          key === "tiktok"
            ? "Videos only, sent from the same composer."
            : "Your own profile or your company's page, from the same composer.",
        to: "connections",
        action: `Connect ${name}`,
        facts: "none",
        step: "accounts",
        optional: true,
        managersOnly: true,
      });
    }
  }
  if (facts.plan.topics === 0) {
    items.push({
      id: "plan.topics",
      title: "Say what you post about",
      why: "A few topics and the times you like to post. Claude drafts from them, and the calendar shows the gaps.",
      to: "social/plan#plan",
      action: "Add topics",
      facts: "none",
      step: "plan",
      optional: true,
      managersOnly: true,
    });
  } else if (!facts.plan.monthlyRunOn) {
    items.push({
      id: "plan.month",
      title: "Have the month drafted for you",
      why: "On your review day Claude drafts the month ahead as drafts for you to read and change. It's off until you switch it on, and nothing is posted without a person.",
      to: "social/plan#month",
      action: "See the monthly run",
      facts: "off",
      step: "plan",
      optional: true,
      managersOnly: true,
    });
  }
  if (!facts.review.saved) {
    items.push({
      id: "review",
      title: "Choose whether posts are checked first",
      why: "Anyone who can write can schedule straight away, unless you'd like an owner or admin to approve each post.",
      to: "settings/social/review",
      action: "Choose",
      facts: "never",
      step: "review",
      optional: true,
      managersOnly: true,
    });
  }
  if (!facts.links.published) {
    items.push({
      id: "links",
      title: "Make a link page for your profile",
      why: "One page with your shop, classes and anything else, to put in your Instagram bio.",
      to: "social/links",
      action: "Make it",
      facts: "off",
      step: "extras",
      optional: true,
      managersOnly: true,
    });
  }
  if (facts.logo === false) {
    items.push({
      id: "logo",
      title: "Add your logo",
      why: "Tag a picture “logo” in Assets and it heads your emails, packing slips and order PDFs.",
      to: "social/library",
      action: "Go to Assets",
      facts: "none",
      step: "extras",
      optional: true,
    });
  }
  return items;
}
