import { expect, test, type Browser } from "@playwright/test";
import type pg from "pg";

import { e2eDatabaseUrl, e2eGoogleUrl } from "../playwright.config";
import { openE2ePool } from "./support/database";
import { PEOPLE, WORKSPACE_DOMAIN } from "./support/google-workspace";
import { writeSamplePdf } from "./support/sample-pdf";

// Google sign-in against the fake Google server (e2e/support/google-stand-in.ts),
// with the settings a deployment on Google Workspace has (playwright.config.ts):
// Google as the identity provider, sign-in held to the Workspace domain, the
// directory on and an administrator group.
//
// Runs after the other tests, on the install they leave behind: set up,
// sign-up open to anyone, password sign-in on. The fake's account chooser
// lists every account whatever the hd hint says, so the app's own check of
// the ID token is what turns the wrong ones away.

let database: pg.Pool;

test.beforeAll(() => {
  database = openE2ePool(e2eDatabaseUrl);
});

test.afterAll(async () => {
  await database.end();
});

async function roleOf(email: string): Promise<string | null> {
  const result = await database.query<{ role: string }>(
    `select role from public."user" where lower(email) = $1`,
    [email],
  );

  return result.rows[0]?.role ?? null;
}

/**
 * Presses "Continue with Google" and picks the account on the fake's
 * chooser. Each person gets their own address, as Better Auth allows only a
 * few sign-ins per address in ten seconds.
 */
async function continueWithGoogle(
  browser: Browser,
  email: string,
  address: string,
) {
  const context = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": address },
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();

  await page.goto("/login");
  await page.getByRole("button", { name: "Continue with Google" }).click();
  await expect(
    page.getByRole("heading", { name: "Choose an account" }),
  ).toBeVisible();
  await page.getByRole("button", { name: email }).click();

  return { context, page };
}

test("a Workspace account signs in with Google, and the admin group makes it an administrator", async ({
  browser,
  request,
}) => {
  const { context, page } = await continueWithGoogle(
    browser,
    PEOPLE.admin.email,
    "198.51.100.31",
  );

  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);

  // Google was asked to offer only the organization's accounts.
  const fake = (await (
    await request.get(`${e2eGoogleUrl}/__fake/state`)
  ).json()) as { authorizations: Array<Record<string, string>> };

  expect(fake.authorizations.at(-1)?.hd).toBe(WORKSPACE_DOMAIN);

  // Dana is in the administrator group, so she is an administrator here.
  expect(await roleOf(PEOPLE.admin.email)).toBe("admin");
  expect((await page.request.get("/api/admin/audit")).status()).toBe(200);
  await context.close();
});

test("someone outside the admin group is a member, and finds colleagues in the directory", async ({
  browser,
}, testInfo) => {
  const { context, page } = await continueWithGoogle(
    browser,
    PEOPLE.sender.email,
    "198.51.100.32",
  );

  await expect(page).toHaveURL(/\/(dashboard|onboarding)/);
  expect(await roleOf(PEOPLE.sender.email)).toBe("user");
  expect((await page.request.get("/api/admin/audit")).status()).toBe(403);

  // The directory search, as the recipient fields ask it. The suspended
  // account and the other organization's people are not offered.
  const search = (await (
    await page.request.get("/api/directory/people?q=dan")
  ).json()) as { enabled: boolean; people: { email: string; name: string }[] };

  expect(search.enabled).toBe(true);
  expect(search.people).toEqual([
    { email: PEOPLE.admin.email, name: "Dana Admin" },
    { email: PEOPLE.colleague.email, name: "Daniel Diaz" },
  ]);

  await test.step("the signer field suggests people from the directory", async () => {
    const pdfPath = await writeSamplePdf(testInfo.outputPath("sample.pdf"));

    await page.goto("/envelopes/new");
    await page.getByLabel("Envelope title").fill("Directory check");
    await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
    await expect(page.getByText("sample.pdf")).toBeVisible();
    await page.getByRole("button", { name: "Next ->" }).click();
    await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

    await page.getByLabel("Signer 1 email").pressSequentially("dani");
    await expect(
      page.getByRole("option", { name: /Daniel Diaz/ }),
    ).toBeVisible();
    await page.getByRole("option", { name: /Daniel Diaz/ }).click();
    await expect(page.getByLabel("Signer 1 email")).toHaveValue(
      PEOPLE.colleague.email,
    );
    await expect(page.getByLabel("Signer 1 name")).toHaveValue("Daniel Diaz");
  });

  await context.close();
});

test("accounts outside the organization's Workspace are turned away", async ({
  browser,
}) => {
  const other = await continueWithGoogle(
    browser,
    PEOPLE.otherWorkspace.email,
    "198.51.100.33",
  );

  await expect(other.page).toHaveURL(/\/login/);
  await expect(
    other.page.getByText(
      "This Google account belongs to a different organization's Workspace.",
    ),
  ).toBeVisible();
  await other.context.close();

  const personal = await continueWithGoogle(
    browser,
    PEOPLE.personal.email,
    "198.51.100.34",
  );

  await expect(personal.page).toHaveURL(/\/login/);
  await expect(
    personal.page.getByText("not a personal Google account"),
  ).toBeVisible();
  await personal.context.close();

  // Neither got an account.
  expect(await roleOf(PEOPLE.otherWorkspace.email)).toBeNull();
  expect(await roleOf(PEOPLE.personal.email)).toBeNull();
});
