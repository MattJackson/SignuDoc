# Development

How to run SignuDoc on your own machine, test it, and find your way around the code. For deploying and running an install, see the [self-hosting guide](self-hosting.md).

## Run it locally

For development, or to try it on your own machine first.

### 1. Install dependencies

```bash
npm install
```

SignuDoc targets Node.js 24 and is built on Next.js 16.

### 2. Create your environment file

```bash
cp .env.example .env
```

The example file is ready for local development as it is. Uploaded PDFs are kept on disk under `.data/storage` and outgoing email is written to `.data/outbox` as JSON files instead of being sent, so you need no storage or email account to try the whole product.

Every setting, and which ones are optional, is described in `.env.example`.

### 3. Start the database and apply the schema

SignuDoc runs on Postgres (the default) or SQLite; see [Database](#database). The quickest start needs nothing installed: put a SQLite file in `.env`, and the migrations make it.

```bash
DATABASE_URL=sqlite:.data/signudoc.db
BETTER_AUTH_SECRET=any-random-value-of-32-characters-or-more
```

```bash
npm run db:migrate
```

For Postgres, with Docker installed, this starts it and applies the migrations:

```bash
npm run db:start
```

If you already have a Postgres server, point `DATABASE_URL` at it and run the migrations on their own:

```bash
npm run db:migrate
```

### 4. Start the dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### 5. Set the site up

The first time you open the app it takes you to `/setup`, where you name the organization, give a support address and create the administrator. [Set the site up](self-hosting.md#set-the-site-up), in the self-hosting guide, explains each choice.

## Built with

- Next.js App Router
- React + TypeScript
- Better Auth
- Postgres (`pg`)
- Vercel Blob object storage (local disk in development)
- Resend for transactional email
- `pdf-lib` and `pdfjs-dist`
- Tailwind CSS 4 + shadcn/ui

## How the workflow fits together

1. Upload a PDF and create a draft envelope.
2. Add signers in the order they should receive it.
3. Place fields on the document.
4. Review and send.
5. The first signer receives a secure link.
6. Each signer completes their turn in order.
7. SignuDoc finalizes the signed PDF and audit certificate when the last signer finishes.

People added to receive a copy do not sign. They are sent the finished document and its certificate at step 7 and nothing before it.

A document you send often can be kept as a template: open any envelope, sent or not, and choose Save as template. The template keeps the document, the fields and the signing order, and no one's name or email address. Using it asks who signs this time and opens a draft at step 4. Send to many takes a CSV of names and addresses and sends one envelope per row, so the same form can go out to many people without repeating those steps.

## Storage

Documents, signed PDFs, audit certificates, drawn signature images, and the small first-page pictures shown on the dashboard are stored in one of two places:

- **Vercel Blob**, in a private store. This is used whenever a Blob store is connected to the project (Vercel sets `BLOB_READ_WRITE_TOKEN`, or `BLOB_STORE_ID` for a store that signs in with the project's OIDC token), and always on Vercel. Nothing in the store has a public URL; every download goes through the app, which checks who is asking first.
- **Google Cloud Storage**, in a bucket named by `GCS_BUCKET` (and optionally a folder in it, `GCS_PREFIX`), through the JSON API with the app's shared Google credentials (`src/lib/integrations/google/credentials.ts`). Only chosen with `STORAGE_DRIVER=gcs`. See [Files in Google Cloud Storage](self-hosting.md#files-in-google-cloud-storage).
- **Local disk**, under `.data/storage` (change it with `STORAGE_LOCAL_DIR`). This is the default everywhere else, including local development.

`STORAGE_DRIVER=blob`, `STORAGE_DRIVER=gcs` or `STORAGE_DRIVER=local` overrides the choice. On Cloud Storage and local disk uploads go through the app.

On Vercel Blob, the upload page sends the PDF straight from the browser to the store with a short-lived signed URL, because a request to a Vercel Function cannot be larger than 4.5 MB. The upload lands in a pending folder, the app reads it back and validates it like any other upload, stores its own copy, and deletes the pending one. A pending upload that is never picked up is deleted by Blob after a day.

To run the end-to-end test against a real Blob store instead of local disk:

```bash
E2E_STORAGE_DRIVER=blob BLOB_READ_WRITE_TOKEN=... npm run test:e2e
```

## Database

SignuDoc talks to Postgres with `pg`. Any Postgres 15 or newer works, including Neon and Supabase. Postgres is the default, and what Vercel and most installs use.

It also runs on SQLite, through Node's built-in `node:sqlite` (no extra package), when `DATABASE_URL` is a `sqlite:` URL: `sqlite:/absolute/path/file.db` or `sqlite:relative/path/file.db`. That is what the fork's Cloud Run deployment uses, one instance with the file copied to Cloud Storage by Litestream ([Deploy on Google Cloud Run](../examples/google-cloud-run/README.md)). The app's code is the same on both: it writes Postgres SQL, and the SQLite pool in `src/lib/db/sqlite/` translates it, converts values so they come back exactly as `pg` returns them, and runs one transaction at a time. [The design](design/database-backends.md) explains how, and what to keep in mind.

The schema lives in `db/migrations` as plain SQL files for Postgres. `npm run db:migrate` applies the ones that have not run yet and records them in the `signudoc_migrations` table, so it is safe to run on every deploy. On SQLite it applies `db/sqlite/baseline.sql` (everything up to the migrations listed in `db/sqlite/baseline.versions`) to a new database, then the files in `db/sqlite/migrations`.

**Every schema change needs two migrations:** the Postgres one in `db/migrations`, and its SQLite version with the same file name in `db/sqlite/migrations`. CI fails without the second (`db/sqlite/migrations.test.mjs`), and the database tests compare the two schemas column by column.

SQL in the app is checked against SQLite in CI as well: `src/lib/db/sqlite/rewrite.test.ts` finds every statement passed to `query`, `queryOne` and `queryMany`, translates it and prepares it against the SQLite schema. A query the translation does not support fails there, with the file and line; the fix goes in `src/lib/db/sqlite/rewrite.ts` or `functions.ts`, not in the query. A query built from pieces the test cannot work out needs a stand-in in `src/lib/db/sqlite/sql-corpus-exceptions.ts`.

To copy an install's data between databases, of either kind: `npm run transfer-database -- --from <URL> --to <URL>`.

## Email delivery

SignuDoc sends transactional email through Resend.

- The support address, where replies go, is asked for when the site is set up. It and the address email is sent from can be changed by the administrator under Settings, Organization. The sender address must be at a domain verified with Resend; the same page adds the domain to Resend, lists the DNS records and checks them. With a Resend API key that is only allowed to send, it points you at Resend's dashboard for that step instead.
- `RESEND_FROM_EMAIL` and `SUPPORT_EMAIL` are optional. When set they take the place of the addresses saved in Settings, which then cannot be changed there, and with `SUPPORT_EMAIL` set the setup page does not ask for a support address.
- Until a sender address is set, mail goes out from `onboarding@resend.dev`, which Resend only delivers to the owner of the Resend account.
- In hosted mode the support address is also the contact shown on the Terms, Privacy, and Accessibility pages.
- For local development, `EMAIL_DRIVER=capture` writes each email to `.data/outbox` as a JSON file instead of sending it. Open the newest file to find a verification or signing link. Use a delivery provider for deployed sites that need to send email: on a deployed site the capture driver refuses to run, because it delivers no mail.

To test a production build on your machine, set `APP_URL=http://localhost:3000` and `EMAIL_DRIVER=capture` in your local `.env`. With the example database password, sign-in also needs a `BETTER_AUTH_SECRET` of at least 32 characters. Generate one with `openssl rand -hex 32` and save its output as `BETTER_AUTH_SECRET` in the same file. Run `npm run build`, then `npm run start`.

## Upload constraints

Document import currently enforces these limits:

- PDF files only
- 20 MB maximum upload size, and at most 1,000 pages
- password-protected or encrypted PDFs are rejected
- pure XFA or unsupported PDF variants are rejected

## Common scripts

```bash
npm run dev
npm run build
npm run start
npm run db:start
npm run db:stop
npm run db:reset
npm run db:migrate
npm run auth:generate
npm run lint
npm run typecheck
npm run format
npm run format:check
npm test
npm run test:db
npm run test:e2e
```

`npm test` runs the unit tests, which need nothing else running (the SQLite backend's included). `npm run test:db` runs the tests that need a real database against the `signudoc_e2e` database on Postgres, or on SQLite with `E2E_DATABASE_URL=sqlite:/tmp/signudoc/signudoc_e2e.db npm run test:db`, which gives each test file a new file of its own. `npm run test:e2e` takes the same `E2E_DATABASE_URL`. CI runs both on both backends.

`npm run test:e2e` runs the Playwright end-to-end test. It starts the app against a separate `signudoc_e2e` database on the same Postgres server, sets the site up as its first visitor, signs up a sender, sends a PDF, signs it as the recipient and downloads the results. Then a second Playwright project, `google-workspace`, signs in with Google against the fake Google server below. Install the browser once with `npx playwright install chromium`.

## The fake Google server

Tests do not reach Google. `src/lib/integrations/google/test-support/fake-google.ts` is a stand-in for the parts of Google the app talks to, one plain Node HTTP server on `127.0.0.1` with no dependencies:

- **Google sign-in:** OpenID Connect discovery, an account chooser page, the token endpoint (authorization code with PKCE, refresh tokens), JWKS and userinfo. ID tokens are signed for Google's real issuer, `https://accounts.google.com`, and carry `hd` for a Workspace account (none for a personal one), so the app checks them exactly as it checks Google's. A `login_hint` naming an account skips the chooser. The chooser lists every account whatever the `hd` hint says, so a test can try the wrong one.
- **Service accounts:** the JWT bearer grant, with a subject for domain-wide delegation, and IAM `signJwt`. Assertions from a service account whose key the fake was given are checked against it.
- **Admin SDK Directory API:** users search (the `query` language: `givenName:`, `familyName:`, `name:`, `email:` with a trailing `*`, `isSuspended=`, `directManager=` and more), one user with the manager in `relations`, groups by user or customer, group members (optionally derived), and `hasMember` through nested groups.
- **Drive API v3:** uploads (multipart, media and resumable) with conversion into Docs, Sheets and Slides, `files.get` with `alt=media`, `files.export` (a PDF that was converted comes back as it was; anything else as a one-page PDF naming the file), `files.list` with the `q` language (`appProperties has { key=... and value=... }`, `'id' in parents`, `name`, `mimeType`, `trashed`, times, `and`/`or`/`not`), copy, update with `addParents`/`removeParents`, permissions and shared drives.

Like Google, it answers only with `id`, `name` and `mimeType` for a Drive file unless `?fields=` asks for more, finds files in shared drives only with `supportsAllDrives=true`, refuses to download a Google Docs file, refuses a token without the right scope, and answers 400 to a query term it does not know rather than guessing.

The app is pointed at it with two variables, honoured only for loopback addresses (`src/lib/integrations/google/endpoints.ts`): `GOOGLE_OAUTH_BASE_URL` takes the place of `accounts.google.com` and `oauth2.googleapis.com`, and `GOOGLE_API_BASE_URL` of every other `*.googleapis.com` API, keeping the path. Code that calls a Google URL wraps it in `googleUrl(...)` so tests can redirect it; without the variables nothing changes.

In a unit or database test:

```ts
import {
  startFakeGoogle,
  createFakeServiceAccountKey,
} from "./test-support/fake-google.ts";

const key = createFakeServiceAccountKey();
const google = await startFakeGoogle({
  directoryDomains: ["acme.example"],
  groups: [{ email: "admins@acme.example", members: ["dana@acme.example"] }],
  serviceAccounts: [key],
  users: [
    { email: "dana@acme.example", familyName: "Admin", givenName: "Dana" },
  ],
});
const env = { ...google.env, GOOGLE_SERVICE_ACCOUNT_KEY: JSON.stringify(key) };
// ... createGoogleCredentials({ env }), the code under test ...
await google.close();
```

`google.state` holds everything it has (files, tokens, authorization requests), and `google.issueAccessToken(...)` hands out a token directly. The end-to-end test runs it as a process (`e2e/support/google-stand-in.ts`) with the Workspace in `e2e/support/google-workspace.ts`; from another process, `GET /__fake/state` shows what it holds and `POST /__fake/users`, `/__fake/groups` and `/__fake/drives` add to it.

## Maintaining the fork

This repository is a fork of [NYLLON-SOFTWARE/SignuDoc](https://github.com/NYLLON-SOFTWARE/SignuDoc) for Google Workspace and Google Cloud. It follows the original project and publishes releases of its own, which installs take (docs/self-hosting.md, "Keep your install up to date").

**Versions.** The fork numbers its releases with plain semantic versions, no pre-release part, always above the upstream version it is built on: it started at 0.5.0 on upstream 0.4.0, moved to 0.6.0 when upstream released 0.5.0, and to 0.8.0 when upstream released 0.7.0, before its first release. After that it moves as semantic versioning says for its own changes, and a sync that brings in a new upstream minor or major release moves it to at least the next minor, so it stays above the upstream base. `package.json` records both: `version` is the fork's, and `upstream` names the original project and the upstream release the code is based on. Settings shows both (`src/lib/software-update.ts`), and a unit test checks the fork's version is above the upstream one.

**Upstream sync.** `.github/workflows/sync-upstream.yml` runs every Monday and on demand (Actions, Sync upstream, Run workflow, optionally with a release tag such as `v0.5.0`). It merges upstream's main branch into `sync/upstream-<date>` and opens a pull request listing the upstream commits and the newest upstream release included; it also updates `upstream.version` in `package.json`. When files clash, the pull request is opened from upstream's commit itself, so GitHub shows the conflicts, and lists the files with the commands to resolve them locally. Expect `package.json` (`version`) and `CHANGELOG.md` to clash at every upstream release: keep the fork's version and entries, and put upstream's entries below them. When the branch cannot be pushed (upstream changed a file in `.github/workflows`, which the workflow's own token may not touch) or a pull request cannot be opened, the workflow opens an issue instead with the same details. Upstream's tags are fetched under `refs/upstream/tags`, never into this repository's tags, since both number releases `v0.x.y`.

To merge upstream by hand:

```bash
git remote add upstream https://github.com/NYLLON-SOFTWARE/SignuDoc.git
git fetch upstream main
git checkout -b sync/upstream-manual origin/main
git merge upstream/main
npm pkg set upstream.version=<newest upstream release>
```

**Releases.** To release the fork:

1. Move `version` in `package.json` (and `package-lock.json`) as above, and turn `## [Unreleased]` in `CHANGELOG.md` into the new version with its date, saying which upstream release it is built on.
2. Merge to `main`, tag it `v<version>` and publish a GitHub Release with the changelog entry as its notes. `release-artifacts.yml` attaches the SBOM and source archive with their attestations.
3. Installs see it in Settings, and their Update SignuDoc workflow opens a pull request with it.

`SIGNUDOC_RELEASES_REPO` (an environment variable for Settings, a repository variable for the workflows) points an install, or a further fork, at another release source; the fork's own repository is set in `package.json` (`repository`). `SIGNUDOC_UPSTREAM_REPO`, a repository variable, changes where the sync workflow fetches from.

## Project structure

```text
src/app         Next.js routes, layouts, and API handlers
src/components  UI shells and reusable components
src/lib         Auth, database, services, schemas, and domain logic
db              SQL migrations and the script that applies them
e2e             The Playwright end-to-end test
public/pdfjs    PDF.js worker and standard font assets
```
