import { expect, test } from "@playwright/test";

test("home page introduces the product and links to sign-in", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("people who make things");
  await page.getByRole("link", { name: "Get started" }).click();
  await expect(page).toHaveURL(/\/login$/);
});

test("login offers a magic link and Google", async ({ page }) => {
  await page.goto("/login");
  await expect(page.getByLabel("Email")).toBeVisible();
  await expect(page.getByRole("button", { name: "Email me a sign-in link" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
});

test("login refuses an address that isn't an email", async ({ page }) => {
  await page.goto("/login");
  // Passes the browser's own check, so the server-side validation is what answers.
  await page.getByLabel("Email").fill("a@b");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText("That email address doesn't look right.")).toBeVisible();
});

for (const path of [
  "/app",
  "/onboarding",
  "/w/some-workspace",
  "/w/some-workspace/settings/team",
  "/w/some-workspace/bookings",
  "/w/some-workspace/social/new",
  "/w/some-workspace/assistant",
  "/w/some-workspace/messages",
  "/invite/abc",
]) {
  test(`signed-out visitors to ${path} are sent to sign in, then back`, async ({ page }) => {
    await page.goto(path);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(path)}$`));
    await expect(page.getByLabel("Email")).toBeVisible();
  });
}

test("the health check answers without a session", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.ok()).toBe(true);
  expect(await res.json()).toEqual({ ok: true });
});

test("pricing lists the three plans and leads to sign-in", async ({ page }) => {
  await page.goto("/pricing");
  for (const plan of ["Starter", "Growth", "Studio"]) {
    await expect(page.getByRole("heading", { name: plan, exact: true })).toBeVisible();
  }
  await expect(page.getByText("$99")).toBeVisible();
  await page.getByRole("link", { name: "Start free trial" }).first().click();
  await expect(page).toHaveURL(/\/login$/);
});

test("the Stripe webhook refuses unsigned requests", async ({ request }) => {
  const res = await request.post("/api/webhooks/stripe", { data: { id: "evt_fake" } });
  expect([400, 503]).toContain(res.status());
});

test("the Shopify webhook refuses unsigned requests", async ({ request }) => {
  const res = await request.post("/api/webhooks/shopify", { data: { id: 1 } });
  expect([401, 503]).toContain(res.status());
});

test("a connection callback without a matching session goes nowhere useful", async ({ page }) => {
  await page.goto("/api/connections/shopify/callback?code=x&state=y&shop=evil.myshopify.com");
  await expect(page).toHaveURL(/\/login/);
});

test("the inbound email webhook refuses requests without its secret", async ({ request }) => {
  const res = await request.post("/api/webhooks/postmark", { data: { MessageID: "x" } });
  expect([401, 503]).toContain(res.status());
});

test("the booking payments webhook refuses unsigned requests", async ({ request }) => {
  const res = await request.post("/api/webhooks/stripe-connect", { data: { id: "evt_fake" } });
  expect([400, 503]).toContain(res.status());
});

test("booking pages are public, and unknown ones are simply not found", async ({ page }) => {
  // No sign-in redirect: the visitor stays on the address and sees "not found".
  await page.goto("/book/no-such-workspace");
  await expect(page).toHaveURL(/\/book\/no-such-workspace$/);
  await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
  await page.goto("/booking/not-a-real-booking-link-000000");
  await expect(page).toHaveURL(/\/booking\/not-a-real-booking-link-000000$/);
  await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
});

test("the embed script is served to other sites", async ({ request }) => {
  const res = await request.get("/embed.js");
  expect(res.ok()).toBe(true);
  expect(await res.text()).toContain("data-maker-booking");
});

test("a link page that doesn't exist, or isn't published, is simply not found", async ({
  page,
}) => {
  await page.goto("/links/nobody-here");
  await expect(page.getByRole("heading", { name: "We couldn't find that page" })).toBeVisible();
});
