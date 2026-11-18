# Google Workspace

SignuDoc works with any organization's Google Workspace. Once it is set up, anyone at the organization signs in with their Google account and can send documents straight away: a salesperson types a customer's address and picks their manager from the directory as a second signer. Administrators can be managed with a Google Group.

Everything here is set in the app, in Settings, Google Workspace, and in the same steps of onboarding (`/onboarding`, where first-run setup ends). Each part is a checklist with live checks and this site's own values to paste into Google's consoles. Every setting also has an environment variable; one that is set wins, and the app shows the setting as fixed.

There are five parts. Only the first is needed for sign-in.

1. [Google sign-in](#1-google-sign-in)
2. [The Workspace directory](#2-the-workspace-directory): suggest colleagues as recipients
3. [An administrator group](#3-an-administrator-group)
4. [Google Drive](#4-google-drive): start envelopes from Drive, and keep executed copies in a Shared Drive
5. [The Gmail and Drive add-on](#5-the-gmail-and-drive-add-on): send for signature from the side panel

## 1. Google sign-in

### Create the OAuth client

In the [Google Cloud console](https://console.cloud.google.com), in the project the site runs in (or any project in your organization):

1. Open **Google Auth Platform**, **Audience**, and set the user type to **Internal**. Only accounts in your Workspace can then use the client, and Google does not need to review the app.
2. Open **Clients**, choose **Create client**, and pick **Web application**.
3. Under **Authorized redirect URIs**, add `https://<your site>/api/auth/callback/sso`. The page in Settings shows the exact value for your site, with a copy button. It is built from `APP_URL` (or `BETTER_AUTH_URL`); if the site does not know its own address yet, set one of those.
4. The scopes are the basic ones, `openid`, `email` and `profile`. Nothing else is asked for.
5. Copy the **client ID** and **client secret**.

### Enter it in SignuDoc

In Settings, Google Workspace, Google sign-in, paste the client ID and client secret and save. The issuer is Google's (`https://accounts.google.com`); "Use another provider" takes any other OpenID Connect issuer instead.

- The client secret is stored encrypted with a key derived from `BETTER_AUTH_SECRET`, the same way as the install's seal key, and is never shown again. If `BETTER_AUTH_SECRET` changes, it can no longer be read; enter it again.
- A change applies within about a minute on every instance, with no restart or redeploy: the app's auth server is built again when its sign-in settings change.
- With environment variables instead: `SSO_ISSUER=https://accounts.google.com`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`, and optionally `SSO_NAME`. When any of the three is set, the environment decides and the form is locked.

The sign-in and sign-up pages then show **Continue with Google**.

### Hold sign-in to your Workspace

With Google as the issuer, SignuDoc checks every Google sign-in against your Workspace, not only the first one:

- Google is asked to offer only accounts in your Workspace (the `hd` parameter).
- The `hd` claim in Google's signed ID token names the Workspace an account belongs to. It must be one of your Workspace domains, or the sign-in is refused. A personal Google account has no `hd` claim and is always refused. This holds even if the OAuth client were set to External by mistake.

The domains are, in order: `GOOGLE_WORKSPACE_DOMAINS` (comma-separated), the "Workspace domains" field, or the sign-up rule's domains. With none of these, any Workspace account passes, and a personal account does not.

### Limit sign-up to your domain

Someone who signs in for the first time gets an account under the site's sign-up rule (Settings, Organization, Who can create an account). Set it to "People at my organization" with your Workspace's domain. The checklist shows whether it is.

### Turn password sign-in off

With Google sign-in working, turn password sign-in off, so Google decides who gets in and its MFA, login challenges and offboarding apply. Keep one or two administrators' addresses as **break-glass addresses**: they can still sign in with a password if Google is unavailable, and the app does not let password sign-in be turned off without one. Keep those accounts' passwords somewhere safe, with two-step sign-in turned on.

The environment equivalent is `PASSWORD_SIGN_IN=off` with `PASSWORD_SIGN_IN_ALLOWED_EMAILS`.

## 2. The Workspace directory

With the directory on, the signer and copy-recipient fields (when preparing an envelope and when using a template) suggest people from your Workspace as the sender types a name or the start of an address. Picking one fills in the address, and the name if it is empty. People outside the organization are typed in full, as before. Only active accounts are suggested, and only their name and primary address are used.

### The service account

The app reads the directory as a Google service account, through the Admin SDK Directory API, read-only:

- **On Google Cloud** (Cloud Run, GKE, Compute Engine) it is the service account the site runs as, with no key stored. Give the site its own service account rather than the default compute one.
- **Anywhere else**, set `GOOGLE_SERVICE_ACCOUNT_KEY` to a service account key (the JSON file, or the same in base64).

Settings shows which service account the site runs as, with a copy button. In the Google Cloud project, enable the **Admin SDK API**.

### Give it read access

There are two ways. The first is preferred.

**A read-only administrator role (no domain-wide delegation).** The service account calls the API as itself and can never act as anyone in your organization.

1. In the [Google Admin console](https://admin.google.com), open **Account**, **Admin roles**, and choose **Create new role**. Name it, for example, "SignuDoc directory reader".
2. Under **Admin API privileges**, tick **Users, Read** and **Groups, Read**. Nothing else.
3. Open the new role, choose **Assign service accounts**, and paste the service account's address.

**Domain-wide delegation.** For organizations that already manage access this way.

1. In the Admin console, open **Security**, **Access and data control**, **API controls**, **Manage Domain Wide Delegation**, and add the service account's client ID with exactly these scopes:
   `https://www.googleapis.com/auth/admin.directory.user.readonly,https://www.googleapis.com/auth/admin.directory.group.readonly`
2. In SignuDoc, set "Act as administrator" (or `GOOGLE_WORKSPACE_ADMIN_SUBJECT`) to an administrator the service account reads the directory as.
3. On Google Cloud without a key, the service account also needs the **Service Account Token Creator** role on itself, so the app can sign the delegation assertion through the IAM Credentials API.

"Customer ID" (or `GOOGLE_WORKSPACE_CUSTOMER_ID`) is only needed to read a Workspace other than the one the service account belongs to; it defaults to your own (`my_customer`).

### Test it and turn it on

**Test directory access** looks you up in the directory through the same access the app would use, and says what Google answered: for example a 403 when the role is not assigned yet or a scope is missing. When it works, choose **Turn suggestions on** (or set `GOOGLE_WORKSPACE_DIRECTORY=on`).

Lookups are cached for a minute and limited per sender, and Google's error messages are never passed on, only the status.

## 3. An administrator group

Optional, and needs the directory to be readable. Name a Google Group (for example `signudoc-admins@yourcompany.com`) in "Administrator group", or set `GOOGLE_ADMIN_GROUP`. Then, at each Google sign-in:

- a member of the group (directly, or through a nested group) becomes an administrator;
- an administrator who is no longer in the group stops being one;
- the last administrator is never removed, whatever the group says, so a group emptied by mistake cannot leave the site without one;
- if Google cannot be asked, nothing changes;
- password sign-ins are not changed, so a break-glass account keeps its role.

Every change is recorded in the site audit trail as a role change, naming the group. **Test group lookup** checks whether you are in the group before you save it: if you are not, adding yourself first keeps you an administrator when you next sign in with Google.

## 4. Google Drive

Four features, each optional and off until set up, in Settings, Google Workspace, Google Drive (and the Google Drive step of onboarding):

- **Start from Google Drive**: "Choose from Google Drive" on the new-envelope page opens the Google Picker. A PDF, a Word, OpenDocument or RTF document, or a Google Doc, Sheet or Slides file becomes a draft.
- **Open with**: "Open with" in Drive's own menu, for PDF and Word files and (with importing on) Google Docs.
- **Executed copies in a Shared Drive**: every completed envelope's sealed PDF and audit certificate, put in a Shared Drive by the site's service account.
- **Labels on executed copies**: a Drive label on each executed copy, with its fields filled from the envelope.

### Each person's own Drive

Starting from Drive and "Open with" read the person's own files, with their own permission, never the service account's. The first time, the person is sent to Google to allow it ("Connect Google Drive"). This is incremental authorization with the Google sign-in OAuth client of [part 1](#1-google-sign-in), so Google sign-in has to be set up with Google as the provider.

- Only the `https://www.googleapis.com/auth/drive.file` scope is asked for. It reaches only the files the person picks in the Picker or opens with this site, and the files the app makes itself. Nothing else in their Drive.
- The flow is the authorization code flow with PKCE and a state value, held in a short-lived encrypted cookie. The Google account that agrees has to be the one the person signs in to SignuDoc with.
- The refresh token Google gives is stored encrypted (`google_drive_tokens`, with a key derived from `BETTER_AUTH_SECRET` and the person's id) and never leaves the server. Access tokens are made from it when needed, and only the short-lived access token is handed to the person's own browser for the Picker.
- "Disconnect Drive" on the new-envelope page revokes the token at Google and deletes it. If Google stops accepting it (the person removed the app from their Google account), it is deleted and the person is asked to connect again. Connecting and disconnecting are in the site audit trail.

A document that is not a PDF is turned into one with Drive: uploaded to the person's Drive as a temporary Google file (converted on the way in), exported as a PDF, and the temporary file deleted. The PDF then goes through the same checks, limits and storage as an upload (`createDraftFromDocument` in `src/lib/integrations/google/import-draft.ts`), and the draft's "created" event in its audit trail says it came from Google Drive.

In the Google Cloud project of the OAuth client:

1. Enable the **Google Drive API** and the **Google Picker API** (and, for labels, the **Drive Labels API**).
2. In **Google Auth Platform**, **Data access**, add the `drive.file` scope. For an Internal app Google does not review it.
3. In the OAuth client, add a second authorized redirect URI, `https://<your site>/api/google/drive/callback`. Settings shows the exact value with a copy button.

### Start from Google Drive

In **APIs & Services**, **Credentials**, create an **API key**. Restrict it to the Google Picker API, and to this site's address as an HTTP referrer (`https://<your site>/*`). In Settings paste it as the browser API key, with the project **number** (from the project's dashboard; the Picker calls it the app ID). Neither is a secret: both are sent to the browser. Or set `GOOGLE_PICKER_API_KEY` and `GOOGLE_DRIVE_APP_ID`.

The Picker is loaded from `apis.google.com` and shows Drive in a frame from `docs.google.com`; the site's Content Security Policy allows those on the app's own pages, and not on the pages signers and downloads use.

### Open with

In the Cloud console, open **Google Drive API**, **Drive UI integration**, give the application name and icons, and enter the values Settings shows with copy buttons:

| Setting                   | Value                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open URL                  | `https://<your site>/api/google/drive/open`                                                                                                          |
| Default MIME types        | `application/pdf`                                                                                                                                    |
| Default file extensions   | `pdf`                                                                                                                                                |
| Secondary MIME types      | `application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword,application/vnd.oasis.opendocument.text,application/rtf` |
| Secondary file extensions | `docx,doc,odt,rtf`                                                                                                                                   |
| Importing                 | On, with import format `application/pdf`, so Google Docs can be opened too                                                                           |

Drive then sends the person to the open URL with a `state` naming the file. They are asked to sign in to SignuDoc if they are not, and to connect Drive the first time; a draft is made from the file and they continue with choosing its signers. The Google account that opened the file in Drive has to be the one connected.

For "Open with" to show for everyone in the organization, list the app privately with the **Google Workspace Marketplace SDK** (Drive integration on, the `drive.file` scope) and install it for the domain from the Admin console.

### Executed copies in a Shared Drive

When an envelope is completed, its sealed PDF and its audit certificate (the full one, with addresses) are put in a Shared Drive by the site's service account (the same one as for the directory, see [part 2](#the-service-account)), with the Drive API's `drive` scope.

1. Open the Shared Drive, choose **Manage members**, and add the service account as a **Content manager**. Settings shows its address with a copy button.
2. A service account is not part of your Workspace. If Drive refuses to add it, allow members from outside the organization for this Shared Drive: in the Admin console, **Apps**, **Google Workspace**, **Drive and Docs**, **Sharing settings**, let shared drives have members outside the organization (for the organizational unit that owns the drive), and in the Shared Drive's own settings allow people outside the organization.
3. In Settings, **List the Shared Drives it can see** and pick one, or paste its ID (or its address from the browser), then **Test Shared Drive access**. Or set `GOOGLE_DRIVE_EXPORT_DRIVE_ID`.
4. Optionally change the folder layout (`GOOGLE_DRIVE_EXPORT_FOLDER_PATTERN`). The default is `{yyyy}/{yyyy-MM-dd} — {title} — {shortId}`: the parts before the last `/` are folders, made as needed; the last part is the file's name, `.pdf` for the sealed PDF and ` — certificate.pdf` for the certificate beside it. The tokens are `{yyyy}`, `{MM}`, `{dd}`, `{yyyy-MM}`, `{yyyy-MM-dd}` (the completion date, in UTC), `{title}`, `{shortId}` (the first 8 characters of the envelope id), `{envelopeId}` and `{senderEmail}`.

How it runs:

- The export is an outbox (`drive_exports`). Its row is written in the same transaction that completes the envelope, so a completion is never missed, even while Google is down.
- Right after the completion the upload is tried once. What fails is tried again by `/api/internal/drive-export`, waiting 5 minutes after the first failure and twice as long after each next one (at most 12 hours), up to 8 tries. Then it waits for an administrator.
- Call `/api/internal/drive-export` every 15 minutes, with `Authorization: Bearer <secret>` when `CRON_SECRET` or `RETENTION_JOB_SECRET` is set (like the other internal routes). On Google Cloud, with Cloud Scheduler:

  ```bash
  gcloud scheduler jobs create http signudoc-drive-export \
    --schedule="*/15 * * * *" --http-method=POST \
    --uri="https://<your site>/api/internal/drive-export" \
    --headers="Authorization=Bearer <secret>"
  ```

  On Vercel, a cron job that often needs a Pro plan, so it is not in `vercel.json`; add one there (`"schedule": "*/15 * * * *"`) on a plan that allows it. Without the schedule, only the try right after completion and the retries from Settings happen.

- A retry never makes a second copy. Each file in Drive carries `appProperties` with the envelope's id and the file's SHA-256, and the Shared Drive is searched for them before anything is uploaded. Every Drive call passes `supportsAllDrives=true`.
- Settings lists the latest exports with their state, the last error and a **Try again** button (in the site audit trail). Saving any of these settings is in the audit trail too.

### Labels on executed copies

Optional. In the Admin console, **Labels**, make a label and publish it, and let it be applied in the Shared Drive. In Settings, **Load labels**, pick it, and choose for each field what fills it: the envelope's title, the sender's name, email address or team, the completed date, the counterparty (the first signer, in signing order, whose address is outside your Workspace domains) or their email address, or the envelope id. Text fields take the value as it is, date fields a date, person fields an email address, and a selection field the choice with the same name.

The label is put on the sealed PDF after the upload, with the Drive Labels API (to read it, scope `https://www.googleapis.com/auth/drive.labels.readonly`) and the Drive API's `files.modifyLabels` (scope `https://www.googleapis.com/auth/drive`). A label that cannot be applied, or a field with no value for an envelope, is noted on the export; the copy still counts as made.

A label's permissions are given to people and groups in your Workspace, which a service account is not part of. If **Load labels** finds nothing, give the service account domain-wide delegation for exactly those two scopes, and set "Apply labels as" (`GOOGLE_DRIVE_LABELS_SUBJECT`) to a user who may apply the label and is a member of the Shared Drive. With the environment, `GOOGLE_DRIVE_LABEL_ID` and `GOOGLE_DRIVE_LABEL_FIELDS` (JSON, such as `{"fieldId":"title","otherFieldId":"counterparty"}`) set the label.

## 5. The Gmail and Drive add-on

Optional. Puts SignuDoc in the side panel of Gmail and Google Drive:

- **In Gmail**, beside an open email: every PDF or Word attachment, each with **Send for signature**. That makes a draft in SignuDoc from the document (a Word file is converted to PDF), with the email's sender as the first signer, and links to the page where the fields are placed and the envelope is sent. Below it, **Contracts with** the sender: the envelopes you can see that involve their address, yours and your teams' sent ones, with their status, and **Nudge** on your own that are waiting on a signer. A nudge is the same reminder as the button on the envelope page, with the same wait between reminders.
- **In Drive**, for a selected PDF, Word file or Google Doc: **Send for signature**, and the envelopes already made from that file.

It is a Google Workspace add-on on Google's HTTP runtime: Google calls this site for every card, so there is no Apps Script project to keep, and the add-on is always the same version as the site. It works the same on Vercel, Cloud Run or anywhere else with a public HTTPS address.

### What it can read

The add-on asks for the fewest scopes that do this, and nothing reads more than the person using it can:

- `gmail.addons.execute` and `gmail.addons.current.message.readonly`: the **open email only**, with a token Google gives for that one message. Never the rest of the mailbox.
- `drive.addons.metadata.readonly` and `drive.file`: the names and types of the files selected, and the contents of a file **only after the person gives it to the add-on**. Drive asks the first time ("Allow access to this file"), for that one file.
- `openid` and `userinfo.email`: who is using it.

Everything is read as the person using the add-on, with the tokens Google puts in each request. The site's own service account is not used.

### How requests are trusted

Every request is checked before anything is read or answered:

1. **That Google sent it, for this add-on.** The deployment asks for `SYSTEM_ID_TOKEN`: Google sends an ID token for the add-on's own service account in the `Authorization` header. Its signature is checked against Google's published keys (cached as long as Google says), its issuer must be Google, its audience the URL that was called, and its email the add-on's service account, verified. This is Google's own recipe in [Validate requests from Google](https://developers.google.com/workspace/add-ons/guides/alternate-runtimes).
2. **Who is using it.** The user ID token in the request must be Google's, for the add-on's OAuth client, with a verified address. Its `hd` claim must be one of your Workspace domains (the same ones Google sign-in is held to). The account is the SignuDoc account with that address; someone with none is shown a card to sign in to SignuDoc once.

Until both values below are saved, the add-on's URLs answer 404. Requests are limited per person, and requests that fail the checks are limited per address.

### Deploy it

In Settings, Google Workspace add-on (and the onboarding step of the same name):

1. **The deployment JSON**, with this site's URLs, to copy or download as `signudoc-addon.json`. It is built from `APP_URL` (or `BETTER_AUTH_URL`). The site's URLs are `https://<your site>/api/google/addon/homepage`, `/gmail-message`, `/drive-items` and `/action`.
2. **The commands**, in a terminal signed in to the Google Cloud project that will own the add-on (the one the site runs in is a good choice):

   ```bash
   gcloud services enable gsuiteaddons.googleapis.com gmail.googleapis.com drive.googleapis.com
   gcloud workspace-add-ons deployments create signudoc --deployment-file=signudoc-addon.json
   gcloud workspace-add-ons get-authorization
   gcloud workspace-add-ons deployments install signudoc
   ```

   After the site's address changes, download the JSON again and run `gcloud workspace-add-ons deployments replace signudoc --deployment-file=signudoc-addon.json`.

3. **Paste what Google printed.** `get-authorization` prints the add-on's `serviceAccountEmail` (like `service-123456789@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`) and its `oauthClientId`. Paste both and save, or set `GOOGLE_ADDON_SERVICE_ACCOUNT` and `GOOGLE_ADDON_CLIENT_ID`.

`deployments install` installs it for you alone, to try it.

### Install it for your organization

To give it to everyone, privately, without publishing it to the public Marketplace:

1. In the same Google Cloud project, enable the **Google Workspace Marketplace SDK**. Under **App configuration**, set the visibility to **Private**, choose **Google Workspace add-on**, pick **Deploy using an alternate runtime** and enter the deployment ID, `signudoc`. Fill in the store listing and publish. A private app is listed only in your own domain and is not reviewed by Google.
2. A Workspace administrator opens the Admin console, **Apps**, **Google Workspace Marketplace apps**, finds it under the apps for your domain, and installs it for everyone or for chosen organizational units. With an administrator install, people are not asked to allow it themselves.

### Behind a proxy

The system ID token's audience is the URL Google calls, which is built from this site's own address. If Google calls a different address (a proxy in front of the site), add it to `GOOGLE_ADDON_AUDIENCE` (comma-separated, `https://` only).

## Environment variables

| Variable                                              | Same as                                                  |
| ----------------------------------------------------- | -------------------------------------------------------- |
| `SSO_ISSUER`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET`    | The OAuth client (all three; any one set locks the form) |
| `SSO_NAME`                                            | Button name                                              |
| `PASSWORD_SIGN_IN`, `PASSWORD_SIGN_IN_ALLOWED_EMAILS` | Password sign-in and break-glass addresses               |
| `GOOGLE_WORKSPACE_DOMAINS`                            | Workspace domains                                        |
| `GOOGLE_SERVICE_ACCOUNT_KEY`                          | The service account, off Google Cloud                    |
| `GOOGLE_WORKSPACE_DIRECTORY`                          | `on` or `off`: suggestions from the directory            |
| `GOOGLE_WORKSPACE_ADMIN_SUBJECT`                      | Act as administrator (domain-wide delegation only)       |
| `GOOGLE_WORKSPACE_CUSTOMER_ID`                        | Customer ID                                              |
| `GOOGLE_ADMIN_GROUP`                                  | Administrator group                                      |
| `GOOGLE_PICKER_API_KEY`, `GOOGLE_DRIVE_APP_ID`        | Browser API key and project number, for the Picker       |
| `GOOGLE_DRIVE_EXPORT_DRIVE_ID`                        | Shared Drive for executed copies                         |
| `GOOGLE_DRIVE_EXPORT_FOLDER_PATTERN`                  | Folder layout                                            |
| `GOOGLE_DRIVE_LABEL_ID`, `GOOGLE_DRIVE_LABEL_FIELDS`  | Label on executed copies, and what fills its fields      |
| `GOOGLE_DRIVE_LABELS_SUBJECT`                         | Apply labels as (domain-wide delegation only)            |
| `GOOGLE_ADDON_SERVICE_ACCOUNT`                        | The add-on's service account                             |
| `GOOGLE_ADDON_CLIENT_ID`                              | The add-on's OAuth client ID                             |
| `GOOGLE_ADDON_AUDIENCE`                               | Extra URLs accepted as the system ID token's audience    |

## Troubleshooting

- **"Sign in with your organization's Google Workspace account"**: the account is a personal Google account.
- **"This Google account belongs to a different organization's Workspace"**: its `hd` claim is not one of your Workspace domains. Add the domain if it is yours (a second Workspace).
- **redirect_uri_mismatch** from Google: the redirect URI in the OAuth client is not exactly the one Settings shows. Check `APP_URL`.
- **"Connect Google Drive" ends with redirect_uri_mismatch**: the OAuth client is missing the second redirect URI, `/api/google/drive/callback`.
- **"That Google account is not the one you sign in to this site with"**: the account chosen at Google, or the one that opened the file in Drive, is not the person's own Workspace account.
- **Executed copies wait with 403 or 404**: the service account is not a Content manager of the Shared Drive, or the Drive API is not enabled in the project.
- **The add-on says "Unauthorized" or shows nothing**: the service account or client ID saved in Settings is not the one `gcloud workspace-add-ons get-authorization` prints, or the deployment's URLs are not this site's address (download the JSON again and run `deployments replace`). The reason is in the site's logs as `google_addon_rejected`.
- **Test directory access says 403**: the role is not assigned to the service account (it can take a few minutes to apply), the Admin SDK API is not enabled in the project, or, with delegation, a scope is missing.
