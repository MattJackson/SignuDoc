import { randomUUID } from "node:crypto";

import { expect, test, type Browser } from "@playwright/test";
import pg from "pg";

import { e2eDatabaseUrl } from "../playwright.config";
import { ADMIN_GROUP, PEOPLE } from "./support/google-workspace";
import { writeSamplePdf } from "./support/sample-pdf";

// The workspace provider against the fake Google server
// (e2e/support/google-stand-in.ts), configured as a deployment on Google
// Workspace would be (playwright.config.ts): Google as the workspace
// provider, the directory on, an administrator group, offboarding on, and
// Google as the single sign-on provider.
//
// Runs after the other tests, on the install they leave behind: set up,
// sign-up open to anyone, password sign-in on.

let database: pg.Pool;

test.beforeAll(() => {
  database = new pg.Pool({ connectionString: e2eDatabaseUrl });
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
 * Signs in with single sign-on and picks the account on the fake's account
 * chooser. Each person gets their own address, as Better Auth allows only a
 * few sign-ins per address in ten seconds.
 */
async function signInWithGoogle(
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
  await expect(page).toHaveURL(/\/dashboard/);

  return { context, page };
}

test("a member of the administrator group becomes an administrator when they sign in", async ({
  browser,
}) => {
  const { context, page } = await signInWithGoogle(
    browser,
    PEOPLE.admin.email,
    "198.51.100.31",
  );

  expect(await roleOf(PEOPLE.admin.email)).toBe("admin");

  // The change is the directory's, in the site audit trail.
  const audit = (await (await page.request.get("/api/admin/audit")).json()) as {
    events: { event: string; metadata: Record<string, unknown> | null }[];
  };

  expect(
    audit.events.some(
      (event) =>
        event.event === "role_changed" &&
        event.metadata?.targetEmail === PEOPLE.admin.email &&
        event.metadata?.group === ADMIN_GROUP &&
        event.metadata?.to === "admin",
    ),
  ).toBe(true);

  await test.step("Settings shows the workspace, fixed by the environment, and its tests pass", async () => {
    await page.goto("/settings");

    const panel = page.locator("#workspace");

    const provider = panel.getByRole("combobox", {
      name: /^Workspace provider/,
    });

    await expect(provider).toHaveValue("google");
    await expect(provider).toBeDisabled();
    await expect(
      panel.getByText("Set by WORKSPACE_PROVIDER on the server."),
    ).toBeVisible();

    await panel.getByRole("button", { name: "Test directory" }).click();
    await expect(panel.getByTestId("workspace-check-directory")).toContainText(
      "The directory can be read",
    );

    await panel
      .getByRole("button", { name: "Test administrator group" })
      .click();
    await expect(panel.getByTestId("workspace-check-adminGroup")).toContainText(
      `You are in ${ADMIN_GROUP}`,
    );
  });

  await context.close();
});

test("someone outside the group stays a member, and the signer field suggests colleagues", async ({
  browser,
}, testInfo) => {
  const { context, page } = await signInWithGoogle(
    browser,
    PEOPLE.sender.email,
    "198.51.100.32",
  );

  expect(await roleOf(PEOPLE.sender.email)).toBe("user");
  expect((await page.request.get("/api/admin/audit")).status()).toBe(403);

  // The search the email fields make. The suspended account is not offered.
  const search = (await (
    await page.request.get("/api/directory/people?q=dan")
  ).json()) as { enabled: boolean; people: { email: string; name: string }[] };

  expect(search).toEqual({
    enabled: true,
    people: [
      { email: PEOPLE.admin.email, name: "Dana Admin" },
      { email: PEOPLE.colleague.email, name: "Daniel Diaz" },
    ],
  });

  const pdfPath = await writeSamplePdf(testInfo.outputPath("sample.pdf"));

  await page.goto("/envelopes/new");
  await page.getByLabel("Envelope title").fill("Directory check");
  await page.getByLabel("Upload PDF").setInputFiles(pdfPath);
  await expect(page.getByText("sample.pdf")).toBeVisible();
  await page.getByRole("button", { name: "Next ->" }).click();
  await expect(page).toHaveURL(/\/envelopes\/[^/]+\/signers$/);

  await page.getByLabel("Signer 1 email").pressSequentially("dani");
  await expect(page.getByRole("option", { name: /Daniel Diaz/ })).toBeVisible();
  await page.getByRole("option", { name: /Daniel Diaz/ }).click();
  await expect(page.getByLabel("Signer 1 email")).toHaveValue(
    PEOPLE.colleague.email,
  );
  await expect(page.getByLabel("Signer 1 name")).toHaveValue("Daniel Diaz");

  await context.close();
});

test("someone suspended in the directory is blocked, and their draft is handed over", async ({
  browser,
}) => {
  // An account from before the directory suspended them, with a draft.
  const userId = randomUUID();
  const envelopeId = randomUUID();

  await database.query(
    `
      insert into public."user" (id, name, email, role, "emailVerified")
      values ($1, 'Dan Gone', $2, 'user', true)
    `,
    [userId, PEOPLE.suspended.email],
  );
  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash
      ) values ($1, $2, 'Left behind', 'draft', $3, 'left.pdf', 10, 1, $4)
    `,
    [envelopeId, userId, `test/${envelopeId}.pdf`, "a".repeat(64)],
  );

  const { context, page } = await signInWithGoogle(
    browser,
    PEOPLE.admin.email,
    "198.51.100.33",
  );

  await page.goto("/settings");

  const panel = page.locator("#workspace");

  await expect(
    panel.getByText("Set by WORKSPACE_OFFBOARDING on the server."),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Run now" }).click();
  await expect(
    panel.getByTestId("workspace-offboarding-last-run"),
  ).toContainText("1 blocked");
  await context.close();

  const blocked = await database.query<{ reason: string | null }>(
    `select directory_blocked_reason as reason from public."user" where id = $1`,
    [userId],
  );

  expect(blocked.rows[0]?.reason).toBe("directory_suspended");

  // No manager in the directory, so an administrator has the draft now.
  const owner = await database.query<{ role: string }>(
    `
      select u.role
      from envelopes e
      join public."user" u on u.id = e.user_id
      where e.id = $1
    `,
    [envelopeId],
  );

  expect(owner.rows[0]?.role).toBe("admin");

  // A password does not get them in either, and they are told why.
  const visitor = await browser.newContext({
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.34" },
  });
  const login = await visitor.newPage();

  await login.goto("/login");
  await login.getByLabel("Email").fill(PEOPLE.suspended.email);
  await login.getByLabel("Password").fill("a long enough passphrase");
  await login.getByRole("button", { name: "Log in" }).click();
  await expect(
    login.getByText("suspended or removed in your organization's directory"),
  ).toBeVisible();
  await visitor.close();
});
