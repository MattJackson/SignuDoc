import { mkdir } from "node:fs/promises";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { PEOPLE } from "./support/google-workspace";

// Full-page screenshots of the administrator's screens: every Settings
// page, each onboarding step and the sign-in page. They are not compared
// with anything; CI uploads them so the screens can be looked at without
// running the app. Runs last, on the install the other tests leave behind,
// signed in with Google as the Workspace administrator.

const OUTPUT_DIR = path.resolve("test-results", "screenshots");

const SETTINGS_PAGES = [
  "/settings",
  "/settings/organization",
  "/settings/setup",
  "/settings/people",
  "/settings/teams",
  "/settings/managers",
  "/settings/integrations",
  "/settings/google-setup",
  "/settings/integrations/google-sign-in",
  "/settings/integrations/google-directory",
  "/settings/integrations/google-drive",
  "/settings/integrations/google-addon",
  "/settings/integrations/email",
  "/settings/integrations/storage",
  "/settings/developers",
  "/settings/documents",
  "/settings/backups",
  "/settings/notifications",
  "/settings/updates",
];

const ONBOARDING_STEPS = [
  "name",
  "branding",
  "organization",
  "email",
  "google-workspace",
  "google-sign-in",
  "google-directory",
  "people",
  "google-drive",
  "google-addon",
  "storage",
  "seal",
  "backups",
  "retention",
  "notifications",
  "done",
];

function fileName(route: string, suffix = ""): string {
  const name = route
    .replace(/^\//, "")
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/-+$/, "");

  return path.join(OUTPUT_DIR, `${name || "home"}${suffix}.png`);
}

async function settle(page: Page) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Panels that load their status after the page shows.
  await page.waitForTimeout(500);
}

async function capture(page: Page, route: string, suffix = "") {
  await page.goto(route);
  await settle(page);
  await page.screenshot({ fullPage: true, path: fileName(route, suffix) });
}

test("screenshots of the administrator's screens", async ({ browser }) => {
  test.setTimeout(300_000);
  await mkdir(OUTPUT_DIR, { recursive: true });

  const signedOut = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 },
  });
  const loginPage = await signedOut.newPage();

  await capture(loginPage, "/login");
  await signedOut.close();

  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.41" },
    reducedMotion: "reduce",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await page.getByRole("button", { name: PEOPLE.admin.email }).click();
  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);

  for (const route of SETTINGS_PAGES) {
    await capture(page, route);
  }

  for (const step of ONBOARDING_STEPS) {
    await capture(page, `/onboarding?step=${step}`);
  }

  // A tablet, for the layouts that fold up.
  await page.setViewportSize({ height: 1024, width: 768 });

  for (const route of [
    "/settings",
    "/settings/integrations",
    "/settings/integrations/google-sign-in",
    "/onboarding?step=google-sign-in",
  ]) {
    await capture(page, route, "-tablet");
  }

  await context.close();
});
