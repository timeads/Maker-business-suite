import { describe, expect, it } from "vitest";
import { parseChannelSettings } from "../helpdesk/social/channels";
import { pageSubscriptions } from "../helpdesk/social/subscriptions";
import {
  accountLabel,
  accountsByPage,
  brandAccounts,
  checkAccountChoices,
  type AccountRow,
} from "./accounts";

const row = (over: Partial<AccountRow> & Pick<AccountRow, "id" | "network">): AccountRow => ({
  platform_id: over.id,
  page_id: "p1",
  name: "First Page",
  handle: null,
  brand_id: "b1",
  active: false,
  offered: true,
  ...over,
});

describe("social accounts", () => {
  const accounts = [
    row({ id: "ig2", network: "instagram", page_id: "p2", name: "Second", handle: "second_shop" }),
    row({ id: "fb2", network: "facebook", page_id: "p2", name: "Second" }),
    row({ id: "fb1", network: "facebook", active: true }),
    row({ id: "ig1", network: "instagram", active: true, handle: "first_shop" }),
  ];

  it("groups by Page, Pages in use first, each Page's Facebook row first", () => {
    expect(accountsByPage(accounts).map((page) => page.accounts.map((a) => a.id))).toEqual([
      ["fb1", "ig1"],
      ["fb2", "ig2"],
    ]);
    expect(accountLabel(accounts[0])).toBe("Instagram · @second_shop");
    expect(accountLabel(accounts[1])).toBe("Facebook · Second");
  });

  it("holds the plan's limit per network, counting the accounts left as they are", () => {
    expect(checkAccountChoices(accounts, [{ id: "fb2", active: true }], 2)).toBeNull();
    expect(checkAccountChoices(accounts, [{ id: "fb2", active: true }], 1)).toMatch(
      /up to 1 Facebook Page at a time/,
    );
    expect(
      checkAccountChoices(
        accounts,
        [
          { id: "fb2", active: true },
          { id: "fb1", active: false },
        ],
        1,
      ),
    ).toBeNull();
  });

  it("a brand's accounts are the ones in use on it", () => {
    expect(brandAccounts(accounts, "b1").map((a) => a.id)).toEqual(["fb1", "ig1"]);
    expect(brandAccounts(accounts, "b2")).toEqual([]);
  });

  it("asks only Pages with an account in use to send, and the rest to stop", () => {
    const settings = parseChannelSettings({ version: 1, instagram: true });
    const scopes = ["pages_manage_metadata", "instagram_basic", "instagram_manage_messages"];
    const wanted = pageSubscriptions(settings, scopes, accounts);
    expect(wanted.find((p) => p.pageId === "p1")?.fields).toContain("messages");
    expect(wanted.find((p) => p.pageId === "p2")?.fields).toEqual([]);
    // Nothing switched on: every Page is asked to stop.
    expect(
      pageSubscriptions(parseChannelSettings({ version: 1 }), scopes, accounts).every(
        (p) => p.fields.length === 0,
      ),
    ).toBe(true);
  });
});
