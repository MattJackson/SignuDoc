# Workspace providers

SignuDoc can use the services an organization works in for a few optional
parts: its directory of people, its files, and an add-in in its mail and
file apps. Everything here is off until a provider is chosen. An install
without one behaves exactly as it would without this page.

Google Workspace is the provider today.

## How providers fit in

Each capability is a contract in `src/lib/workspace/types.ts`: the directory
(`WorkspaceDirectory`), files (`WorkspaceFiles`) and the add-in
(`WorkspaceAddIn`). There is also `WorkspaceSetup`, which every provider has:
the site's own identity and a check for each part. A provider is one
self-contained folder, `src/lib/workspace/providers/<id>/`, holding its
credentials, API calls, test fakes and tests. It exports one package:
`{ id, label, directory?, files?, addIn?, setup }`, with only the
capabilities it offers. The registry (`src/lib/workspace/registry.ts`)
lists the installed packages, and it is the only place that names them. The
rest of the app asks the registry for a capability and gets it, or `null`.

### Adding a provider

A new provider is one folder under `src/lib/workspace/providers/` and one
entry in the registry. Some examples:

- Microsoft 365, through Microsoft Graph: directory, files on OneDrive and
  SharePoint, and an Outlook add-in.
- Okta or JumpCloud: directory only.
- Box or Dropbox: files only.

## Choose providers

One provider for everything: `WORKSPACE_PROVIDER=google`, or the same in
Settings. Mixing providers takes one choice per capability:
`WORKSPACE_DIRECTORY_PROVIDER`, `WORKSPACE_FILES_PROVIDER` and
`WORKSPACE_ADDIN_PROVIDER`. Each of these overrides `WORKSPACE_PROVIDER` for
its own capability. A provider that does not offer a capability is never
used for it.

When a value is set in both places, the environment wins and Settings shows
it as fixed. The choices are kept in the `workspace_settings` table, along
with the other workspace settings that are not secret, and every change is
recorded in the install's audit trail. Nothing secret goes in the database:
the site's keys and client secrets come only from environment variables.

## The site's Google identity

The app calls Google as a service account, with no Google SDK. It finds its
identity in this order:

1. `GOOGLE_SERVICE_ACCOUNT_KEY`: a service account key, the JSON file or the
   same in base64.
2. `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT`: a service account to act as, through
   the IAM Credentials API, with a gcloud application-default login mounted
   into the container (`gcloud auth application-default login`; the file is
   read from `GOOGLE_APPLICATION_CREDENTIALS` or
   `~/.config/gcloud/application_default_credentials.json`). For
   organizations that forbid service account keys. The login needs Service
   Account Token Creator on the account.
3. On Google Cloud (Cloud Run, GKE, Compute Engine): the service account the
   site runs as, from the metadata server, with no key at all.

With none of these the site has no Google identity, and the parts that need
one stay off. Acting as a Workspace user through domain-wide delegation,
which some parts can use, is signed by the key, or by IAM `signJwt` without
one.

## Tests

The tests never reach Google. `src/lib/workspace/providers/google/test-support`
holds a fake Google server (sign-in, service account tokens, the Admin SDK
directory, Drive and the Cloud calls of the setup) that the tests start on
127.0.0.1. `GOOGLE_API_BASE_URL` and `GOOGLE_OAUTH_BASE_URL` point the app at
it; they only take a loopback address, so set by mistake on a real
deployment they are ignored.

## Directory

With the directory on, anyone sending a document sees people from the
organization's directory as they type a signer's or copy recipient's name or
address, and can pick one. Only active people are offered, and only their name
and address reach the browser. Outside recipients are still typed in full.

It is off until an administrator turns it on, in Settings or with
`WORKSPACE_DIRECTORY=on`, so a site that could reach a directory does not
start asking it unasked. The site only ever reads the directory.

For Google Workspace, turn on the **Admin SDK API** in the Google Cloud
project of the site's service account, then give that account read access in
one of two ways:

1. **A read-only administrator role (recommended).** In the Admin console,
   under Account, Admin roles, create a role with only the Admin API
   privileges **Users, Read** and **Groups, Read**, and assign it to the
   service account. The site then reads the directory as itself, with no
   domain-wide delegation, so it can never act as anyone in the
   organization. Enter the Workspace's **Customer ID** (Admin console,
   Account, Account settings; it starts with `C`) in Settings, or set
   `GOOGLE_WORKSPACE_CUSTOMER_ID`.
2. **Domain-wide delegation.** In the Admin console, under Security, API
   controls, Domain-wide delegation, add the service account's client ID with
   exactly these two scopes:

   ```
   https://www.googleapis.com/auth/admin.directory.user.readonly
   https://www.googleapis.com/auth/admin.directory.group.readonly
   ```

   and name an administrator to read the directory as, in Settings or with
   `GOOGLE_WORKSPACE_ADMIN_SUBJECT`. The Customer ID can then stay empty.

**Test directory** in Settings looks you up through the same access the site
uses, whether or not the directory is on yet. Google's errors are reported
by their status only.

## Administrators from a group

Name a group, in Settings or with `WORKSPACE_ADMIN_GROUP`
(`signudoc-admins@yourcompany.com`), and the directory decides who is an
administrator: each time someone signs in with single sign-on, a member of
the group (directly or through a nested group) becomes an administrator, and
an administrator who has left it stops being one. It needs the directory to
be on.

- The last administrator is never removed, so a group emptied by mistake
  cannot leave the site with none.
- If the directory cannot be asked, nothing changes: a failed lookup is not
  taken as "not a member", and the sign-in goes ahead.
- Only an account whose address is confirmed is made an administrator.
- Password sign-ins change nothing, so a break-glass account kept for when
  the identity provider is down keeps its role.
- Every change is in the site audit trail as a role change, with no one
  acting and the group named.

**Test administrator group** in Settings tells you whether you are in the
group, before it can take your role away. Add yourself first.

## Offboarding

With offboarding on, the site asks the directory about each account in the
organization once a day. When the directory says someone is suspended,
archived or deleted:

- they can no longer sign in, with a password or with single sign-on, and
  their sessions end at once;
- their drafts and envelopes out for signature go to their manager in the
  directory, when the manager has an account here that can still be used,
  or else to an administrator. Finished envelopes stay where they are;
  closing the account hands those over. Envelopes given to an administrator
  are marked as handed over, like a closed account's records, so they move
  on if that administrator stops being one.

When the directory says the person is active again, they can sign in again.
The envelopes stay with whoever has them now.

It works with any provider that serves the directory, through
`WorkspaceDirectory.getPerson` (suspended, archived or not there, and the
manager), so an Okta or JumpCloud directory would do the same.

It holds back wherever a mistake would be hard to undo:

- It is off until an administrator turns it on, in Settings or with
  `WORKSPACE_OFFBOARDING=on`, and it needs the directory to be on.
- Only accounts in the organization's domains are asked about: the ones in
  Settings or `WORKSPACE_DIRECTORY_DOMAINS` (for example
  `yourcompany.com,yourcompany.co.uk`), or else the domains the sign-up
  rule allows. An account elsewhere was never in the directory, so it is
  not "missing" from it. With no domains, nothing runs.
- A lookup that fails is never taken as "gone". When more than half of a
  run's lookups fail, the run stops and changes nothing.
- At most `WORKSPACE_OFFBOARDING_MAX_PER_RUN` people (10 unless set, at
  most 500) are blocked per run; the rest wait for the next one.
- The last administrator who can still sign in is never blocked, and nor
  are the break-glass addresses in `PASSWORD_SIGN_IN_ALLOWED_EMAILS`.
- A large organization is gone through over several runs, a thousand
  accounts at a time, those asked about longest ago first.

### The schedule and the job secret

The job is `/api/internal/directory-sync`, with GET or POST. On Vercel it
runs once a day from the cron in `vercel.json`. Elsewhere, call it from any
scheduler, as often as you like:

```sh
curl -fsS -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://sign.yourcompany.com/api/internal/directory-sync
```

It takes the same secret as the daily cleanup, `CRON_SECRET` or
`RETENTION_JOB_SECRET`. Unlike the cleanup it never runs for a caller
without one: it decides who can sign in. With no secret set it answers 204
and does nothing. A run that is turned on but cannot work (no directory, no
domains) answers 503, and one stopped by failing lookups answers 502, so the
scheduler shows it as failed.

### What an administrator sees

Settings, Workspace, Offboarding has the switch, the organization's
domains, what the last run did (when, how many people were checked,
blocked and how many envelopes were handed over), and **Run now**, which
runs it at once as the schedule would. In the site audit trail (Settings,
Security) each block, each lifted block and each hand-over has its own line,
naming the person, the directory's reason and the envelopes that moved.

## Files: start from Drive, and copies of completed envelopes

Files are their own capability (`WorkspaceFiles`), chosen with
`WORKSPACE_FILES_PROVIDER` or `WORKSPACE_PROVIDER`. Google Drive offers two
parts, each off until it is set up:

- **Start an envelope from Drive.** On the new-envelope page, "Start from
  Google Drive" opens a page with the Google Picker. Each person connects
  their own Drive once (OAuth, the `drive.file` scope only: the site can
  read just the files they pick), picks a PDF, a Google Doc, Sheet or
  Slides file, or a Word, Excel, PowerPoint, OpenDocument or RTF file, and
  it becomes a draft, made into a PDF by Drive if it is not one. The
  refresh token is kept per person in `workspace_file_connections`,
  encrypted with a key derived from `BETTER_AUTH_SECRET`; disconnecting (in
  Settings or on that page) revokes it at Google.
- **Copies of completed envelopes.** When an envelope is completed, its
  signed PDF and its certificate are put in a Shared Drive an administrator
  chose, in folders laid out by a pattern (by default
  `{yyyy}/{yyyy-MM-dd} — {title} — {shortId}`). The copy is written to an
  outbox (`workspace_exports`) in the same transaction as the completion,
  tried right after it, and tried again by `/api/internal/workspace-export`
  with a growing wait, up to eight times; Settings lists the copies that
  failed and can try one again. A retry never makes a second copy, and
  completion never waits for, or fails because of, the copy. Optionally a
  Drive label is put on the signed PDF, with envelope values (title, sender,
  completed date, counterparty and so on) in its fields.

Set it up in Settings, "Shared folder for completed envelopes", or with the
variables below; the check there tests the Shared Drive, the label and the
Picker's setup.

1. In the Google Cloud project, enable the **Google Drive API**, the
   **Google Picker API** and, for labels, the **Drive Labels API**.
2. For the Picker: create a browser API key restricted to this site's
   address and the Picker API (`GOOGLE_PICKER_API_KEY`), and note the
   project number (`GOOGLE_PICKER_APP_ID`).
3. For each person's connection: an OAuth client of type Web application
   (`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`). When sign-in
   already uses Google (`SSO_ISSUER=https://accounts.google.com`), its
   client is used and nothing more is needed. Add
   `https://<your site>/api/workspace/files/callback` to the client's
   authorized redirect URIs.
4. For copies: add the site's service account to the Shared Drive as a
   **Content manager**, and give its ID (or its address from the browser)
   as `WORKSPACE_EXPORT_DESTINATION`. `WORKSPACE_EXPORT_FOLDER_PATTERN`
   changes the folders; the last part is the file's name.
5. For a label: publish one in the Admin console (Labels), let the service
   account apply it, and set `GOOGLE_DRIVE_LABEL_ID` and
   `GOOGLE_DRIVE_LABEL_FIELDS`, a JSON object from field ID to value, such
   as `{"field1":"title","field2":"counterparty"}`.

The retry job runs once a day on Vercel (`vercel.json`); a scheduler
elsewhere can call it more often, with `CRON_SECRET` or
`RETENTION_JOB_SECRET` as a bearer token like the daily cleanup. The
Picker's page is the only one whose Content Security Policy lets Google's
script and frames in.

## The Gmail and Drive add-on

The add-in is its own capability (`WorkspaceAddIn`), chosen with
`WORKSPACE_ADDIN_PROVIDER` or `WORKSPACE_PROVIDER`. For Google it is a
Google Workspace add-on with a side panel in Gmail and Drive:

- **In Gmail**, beside an open email: its PDF and Word attachments, each
  with "Send for signature", and the person's own envelopes with the
  email's sender, with a "Nudge" button on those waiting on a signer.
- **In Drive**, for the selected files: "Send for signature" for a PDF, a
  Google Doc, Sheet or Slides file, or a document Drive can convert, and the
  person's envelopes made from that file.

Sending makes a draft, the same way as an upload, with where it came from
noted on the envelope (`source_provider`, `source_kind`, `source_ref`); the
sender of an email is suggested as its first signer. The card then links to
the draft on the site, where the person chooses the signers, places the
fields and sends it.

All requests go to one route, `/api/workspace/add-in/<action>`, which
answers 404 while no add-in is set up. An Outlook add-in in a Microsoft 365
package would use the same route and contract.

### How requests are verified

The add-on is an HTTP add-on: Google calls the site directly, so the site
needs a **public HTTPS address** (`APP_URL`). A local address or plain HTTP
will not do; Settings says so. Every request is checked before anything is
read:

1. Google's system ID token, in the `Authorization` header, must be signed
   by Google (its published keys, cached), issued by Google, not expired,
   for the URL that was called, and for the add-on's own service account
   (`GOOGLE_ADDON_SERVICE_ACCOUNT`) with a verified address.
2. The user ID token must be signed by Google for the add-on's OAuth client
   (`GOOGLE_ADDON_CLIENT_ID`), with a verified address, from a Google
   Workspace account (personal Google accounts are turned away).
3. The account on this site with that address, verified, is the person.
   Someone with no account, or whose address is not verified yet, gets a
   card telling them to sign in to the site first; the add-on never makes
   accounts.

Requests that fail verification are counted per address and refused once
there are too many; each person's requests and drafts are limited too.

### What is read

Only with the tokens Google sends with each request, as the person: the
open message and its attachments in Gmail
(`gmail.addons.current.message.readonly`), and a selected file in Drive
once the person has given it to the add-on (`drive.file`; the card asks
Google for that file when needed). Nothing is read with the site's own
service account, and Google's error bodies are never passed on.

### Deploy it

Settings, "Add-in for Google Workspace", shows everything with this site's
URLs, and checks the setup:

1. In a Google Cloud project, enable the Google Workspace add-ons, Gmail and
   Drive APIs:
   `gcloud services enable gsuiteaddons.googleapis.com gmail.googleapis.com drive.googleapis.com`.
2. Download the deployment file from Settings (`signudoc-addon.json`). It
   names one URL per action (`homepage`, `gmail-message`, `drive-items`,
   `action`), the scopes above, and `SYSTEM_ID_TOKEN` as the authorization
   header. Create the deployment:
   `gcloud workspace-add-ons deployments create signudoc --deployment-file=signudoc-addon.json`
   (later, `deployments replace` after the address changes).
3. `gcloud workspace-add-ons get-authorization` shows the add-on's service
   account and OAuth client ID. Save both in Settings, or set
   `GOOGLE_ADDON_SERVICE_ACCOUNT` and `GOOGLE_ADDON_CLIENT_ID`.
4. Try it yourself: `gcloud workspace-add-ons deployments install signudoc`.
5. For the whole domain, publish it as a **private** listing on the Google
   Workspace Marketplace (Marketplace SDK in the same project, visibility
   "Private", with the same deployment), then install it for the domain
   from the Admin console (Apps, Google Workspace Marketplace apps).

## Setting it up: step by step or automatically

Settings, Workspace, **Set up step by step or automatically** opens one
page, `/settings/workspace-setup`, for the provider in use (or the first
installed one). It lays out what the provider describes through the
`WorkspaceSetup` contract (`src/lib/workspace/types.ts`): `guide()`, the
manual steps as data, and `automatic`, a runner that streams its progress.
The page and its routes (`/api/admin/workspace/setup`, `.../start`,
`.../choose`, `.../run`) name no provider, so a Microsoft 365 provider would
offer its own guide (an Entra app registration, the Graph permissions,
admin consent) and its own automatic runner with no change to them.

Everything either way of setting up saves is a workspace setting (above),
recorded in the audit trail as the administrator's change. Nothing secret
is saved. Running it again is safe: every step keeps what is already there.

### Step by step

Each step has a link into the right page of Google's consoles (in the
site's Cloud project when it is known), this site's own values to copy, a
field to paste Google's value into where one is needed, and a test:

1. **The consent screen and the OAuth client.** Google has no API for
   these. The page shows the app name, the JavaScript origin and the three
   redirect URIs: `/api/auth/callback/sso` (sign-in),
   `/api/workspace/files/callback` (Drive) and `/settings/workspace-setup`
   (the automatic setup). The ID and secret go in `GOOGLE_OAUTH_CLIENT_ID`
   and `GOOGLE_OAUTH_CLIENT_SECRET` where the site runs, or Google sign-in's
   client is used.
2. **The APIs**, one link each. None needs billing.
3. **The site's identity** (below), with its test.
4. **The Picker's browser key**, held to the Picker API and this site, and
   the project number (`google.pickerApiKey`, `google.pickerAppId`).
5. **The customer ID** (`google.customerId`).
6. **The directory role**: "<name> directory reader", Users and Groups
   read, assigned to the service account; tested by reading the directory.
7. **The Shared Drive** "<name> Executed", with the service account as
   Content manager (`files.exportDestination`). Optional.
8. **The add-on**: its deployment and the values Google gives back
   (`google.addonServiceAccount`, `google.addonClientId`), then the private
   Marketplace listing for the domain. Optional.

The names use the organization's name, or the product's (SignuDoc).

### Automatically

One sign-in as a Workspace **super admin** who can also change Cloud
projects (an Owner of the project, or Project Creator to make one), through
the site's own OAuth client. It asks Google for `openid`, `email`,
`cloud-platform` (projects, APIs, keys, service accounts, the add-on),
`admin.directory.rolemanagement`, `admin.directory.user.readonly`,
`admin.directory.customer.readonly`, and `drive` only when a Shared Drive is
to be made. It asks for no refresh token. When the organization's domains
are known (`WORKSPACE_DIRECTORY_DOMAINS`, or the sign-up rule's), only an
account of that Workspace is taken.

The token is used only inside the request that runs the setup, never
stored and never sent to the page, and it is revoked when the run ends,
whether it worked, failed or ran out of time. The sign-in's state and PKCE
verifier wait in a short-lived encrypted cookie.

After the sign-in the page offers the Cloud projects the account can use,
or a new one ("<name> Workspace", in the organization when there is one).
Then, each reported as done, already done, your turn, or failed (with
Google's HTTP status only; Google's own wording is never shown, as it can
name accounts and projects):

1. Make the new project, or use the chosen one, and save it
   (`google.cloudProject`, or fixed by `GOOGLE_WORKSPACE_PROJECT`).
2. Turn the APIs on, in that project and in the projects of the OAuth
   client and the site's identity.
3. Check that the account is a super admin.
4. The site's identity (below).
5. Make or find the Picker key and save it with the project number.
6. Read the customer ID and save it.
7. Make or find the directory role, assign it to the service account, and
   turn the directory on unless it was turned off on purpose.
8. Make the Shared Drive with the service account as Content manager, when
   copies are wanted. Only the Shared Drive this site saved is used again,
   never one found by its name.
9. Deploy or update the add-on, install it for you and save its values,
   when the site has a public HTTPS address.
10. Run the site's own checks with its own identity.

A value an environment variable sets is left as it is. One run at a time
(a database lock), and the whole run, the wait for the project choice
included, is held to 190 seconds, so the last request and the revoke end
well inside the route's 300.

### The site's identity, and why no key is made

The site keeps nothing secret in its database, so the setup never makes a
service account key. On Google Cloud, or with `GOOGLE_SERVICE_ACCOUNT_KEY`
or `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` set, it keeps that identity.
Otherwise it makes the `<name>-workspace` service account in the project,
gives you Service Account Token Creator on it, uses it for the directory
role and the Shared Drive, and ends with a step that is your turn: give the
site that account where it runs, then run the checks again. Either create
a JSON key for it in the console and set `GOOGLE_SERVICE_ACCOUNT_KEY`, or,
where your organization forbids keys, run
`gcloud auth application-default login` and start the container with the
login mounted and `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` set:

```
-v "$HOME/.config/gcloud/application_default_credentials.json:/home/node/.config/gcloud/application_default_credentials.json:ro" -e GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=<name>-workspace@<project>.iam.gserviceaccount.com
```
