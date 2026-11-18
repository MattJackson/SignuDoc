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

With Docker installed, this starts Postgres and applies the migrations:

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

A document you send often can be kept as a template: open any envelope, sent or not, and choose Save as template. The template keeps the document, the fields and the signing order, and no one's name or email address. Using it asks who signs this time and opens a draft at step 4.

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

SignuDoc uses Postgres as its only database and talks to it with `pg`. Any Postgres 15 or newer works, including Neon and Supabase.

The schema lives in `db/migrations` as plain SQL files. `npm run db:migrate` applies the ones that have not run yet and records them in the `signudoc_migrations` table, so it is safe to run on every deploy.

## Email delivery

SignuDoc sends transactional email through Resend.

- The support address, where replies go, is asked for when the site is set up. It and the address email is sent from can be changed by the administrator under Settings, Organization. The sender address must be at a domain verified with Resend; the same page adds the domain to Resend, lists the DNS records and checks them. With a Resend API key that is only allowed to send, it points you at Resend's dashboard for that step instead.
- `RESEND_FROM_EMAIL` and `SUPPORT_EMAIL` are optional. When set they take the place of the addresses saved in Settings, which then cannot be changed there, and with `SUPPORT_EMAIL` set the setup page does not ask for a support address.
- Until a sender address is set, mail goes out from `onboarding@resend.dev`, which Resend only delivers to the owner of the Resend account.
- In hosted mode the support address is also the contact shown on the Terms, Privacy, and Accessibility pages.
- For local development, `EMAIL_DRIVER=capture` writes each email to `.data/outbox` as a JSON file instead of sending it. Open the newest file to find a verification or signing link. This driver refuses to run in production.

## Upload constraints

Document import currently enforces these limits:

- PDF files only
- 20 MB maximum upload size
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

`npm test` runs the unit tests, which need nothing else running. `npm run test:db` runs the few tests that need a real Postgres (the rate limit counter, the cleanup job's lock and first-run setup) against the `signudoc_e2e` database.

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

**Versions.** The fork numbers its releases with plain semantic versions, no pre-release part, always above the upstream version it is built on: it started at 0.5.0 on upstream 0.4.0. After that it moves as semantic versioning says for its own changes, and a sync that brings in a new upstream minor or major release moves it to at least the next minor, so it stays above the upstream base. `package.json` records both: `version` is the fork's, and `upstream` names the original project and the upstream release the code is based on. Settings shows both (`src/lib/software-update.ts`), and a unit test checks the fork's version is above the upstream one.

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
