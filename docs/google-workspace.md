# Google Workspace

SignuDoc works with any organization's Google Workspace. Once it is set up, anyone at the organization signs in with their Google account and can send documents straight away: a salesperson types a customer's address and adds their manager from the directory to approve it first. Administrators can be managed with a Google Group, and people who leave are offboarded from the directory.

Everything here is set in the app, in Settings, Google Workspace, and in the same steps of onboarding (`/onboarding`, where first-run setup ends). Each part is a checklist with live checks and this site's own values to paste into Google's consoles. Every setting also has an environment variable; one that is set wins, and the app shows the setting as fixed.

There are six parts. Only the first is needed for sign-in. Parts 4 to 6 are set in Settings, **Managers, employees and leavers**, and in the onboarding step of the same name; each is off until it is turned on.

1. [Google sign-in](#1-google-sign-in)
2. [The Workspace directory](#2-the-workspace-directory): suggest colleagues as recipients
3. [An administrator group](#3-an-administrator-group)
4. [Offboarding](#4-offboarding): block people who leave, and hand their open work to their manager
5. [The sender's manager](#5-the-senders-manager): the manager approves before anyone else is asked
6. [Employees sign with Google](#6-employees-sign-with-google): confirm an employee signer with their Google sign-in

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

## 4. Offboarding

Optional, and needs the directory to be readable (part 2). The service account's role needs **Users, Read**, which part 2 already asks for. A job checks the accounts on this site against your Workspace directory. For someone the directory says is **suspended**, **archived**, or **no longer there**:

- Their sign-in is blocked, with Google and with a password alike, and they are signed out everywhere. The sign-in page tells them their account was suspended or removed in Google Workspace. A blocked account shows **Sign-in blocked by Google Workspace** in Settings, People.
- Their envelopes that are still out for signature, and their drafts, go to their **manager**: the person in the "manager" field of their directory entry (Admin console, the user's **User information**, or whatever your HR sync writes there). The manager has to have an account here that can still be used: not blocked, not being closed, and active in the directory. Otherwise they go to an administrator (the one who has been here longest and can still sign in). An envelope that came to them from a closed account goes to an administrator, never to the manager.
- Signing goes on as before. Signers keep their links; the envelope's new owner sees it on their dashboard, can remind, correct or void it, and gets the finished document. Each moved envelope's audit trail says who it was handed over from and to.

When the directory later says the person is active again, the block is lifted. Their envelopes stay with whoever has them now.

What it does not touch:

- **Finished envelopes** (completed, declined, voided) stay on the account. If the account is closed, they go to an administrator as usual.
- **Accounts outside your Workspace domains** (the same domains Google sign-in is held to, part 1). With no domains set, nobody is checked.
- **The last administrator** who can still sign in, whatever the directory says, so a mistake cannot lock everyone out of Settings.
- **Break-glass addresses** (part 1), whether or not password sign-in is off right now.
- **Anyone the directory could not be asked about.** A lookup that fails is never read as "gone". If more than half of a run's lookups fail, the run stops and changes nothing.

At most 10 people are offboarded per run (`DIRECTORY_SYNC_MAX_PER_RUN`, from 1 to 500). The rest are reported as deferred and done on the next run, so a directory that suddenly answered "no such user" for everyone could not block the whole organization at once. Each run asks about up to 1,000 accounts, those checked longest ago first; a larger site is gone through over several runs.

Every block, lifted block and hand-over is in the site audit trail (Settings, Security), and so is each run that found something to do, or was a dry run.

### Turn it on

1. Set a job secret, `RETENTION_JOB_SECRET` (or `CRON_SECRET`, the same secret as the daily cleanup's). The offboarding route never runs without one: it decides who can sign in.
2. Turn it on in Settings, Managers, employees and leavers (**Offboard people the directory suspended or deleted**), or with `DIRECTORY_SYNC=on`. `DIRECTORY_SYNC=off` keeps it off whatever the app says.
3. Try a dry run first. It reports exactly what a real run would do, person by person and envelope by envelope, and changes nothing:

   ```bash
   curl -X POST "https://<your site>/api/internal/directory-sync?dryRun=1" \
     -H "Authorization: Bearer $RETENTION_JOB_SECRET"
   ```

   `&limit=3` lowers the per-run cap for one run. The same can be sent as a JSON body, `{ "dryRun": true, "limit": 3 }`.

4. Schedule the real run.

### Schedule it with Google Cloud Scheduler

Create an HTTP job that calls the route every hour:

```bash
gcloud scheduler jobs create http signudoc-directory-sync \
  --location=<region> \
  --schedule="0 * * * *" \
  --time-zone="Etc/UTC" \
  --http-method=POST \
  --uri="https://<your site>/api/internal/directory-sync" \
  --headers="Authorization=Bearer <RETENTION_JOB_SECRET>" \
  --attempt-deadline=300s
```

In the console it is the same: **Cloud Scheduler**, **Create job**, frequency `0 * * * *`, target type **HTTP**, method **POST**, the URL above, and a header `Authorization` with the value `Bearer <RETENTION_JOB_SECRET>`. Anyone who can read the job can read the secret, so keep access to the project's scheduler to the people who may already see it.

A run answers with what it did, as JSON. It answers 502 when it stopped because the directory could not be asked, so the job shows as failed in Cloud Scheduler; 503 when no job secret is set; and 401 when the secret is wrong. Any other scheduler works the same way: a `GET` or `POST` with the header.

With an hourly run, someone who has left loses access here within the hour of being suspended in Google. Their sessions here end when the run blocks them: the app checks each request's session in the database. Only Better Auth's own session cookie can still vouch for itself on the sign-in endpoints for up to five minutes, which gives no access to documents.

## 5. The sender's manager

Needs the directory (part 2). A sender's manager is the person in the "manager" field of their directory entry (Admin console, the user's **User information**, or whatever your HR sync writes there).

- On the signers page, **Add my manager to approve** puts the sender's manager first, as an [approver](teams-and-signing-order.md#approvers) in a step of their own: they approve or reject the document before anyone else is asked, and place no signature.
- A template role can be **Sender's manager**: using the template fills it with the manager of whoever uses it.
- If the directory names no manager, the manager's account is suspended or gone, or the directory does not answer, the sender is told which. Nothing is guessed.

An administrator chooses the rule, for everyone or only for the members of chosen [teams](teams-and-signing-order.md#teams):

- **Off**: the button is there, nothing more is said.
- **Suggest**: the signers and review pages suggest adding the manager when they are not an approver in the first step. The envelope can still be sent.
- **Require**: an envelope is not sent unless the sender's manager is an approver in the **first step** of the signing order. The review page says why and the send is refused, also when the manager cannot be found, so the sender knows to ask their Workspace administrator to set it. The check is made again at the moment of sending, so a change in the directory since the page was opened counts.

The rule does not apply in Part 11 mode, which has no approvers (see [Known gaps](part11/known-gaps.md)). `MANAGER_APPROVAL` (`off`, `suggest` or `require`) sets the rule from the environment and locks it in Settings; the team choice is made in Settings. Changes are in the site audit trail as a settings change.

## 6. Employees sign with Google

Needs Google sign-in (part 1) with Google as the provider, and your Workspace domains (part 1, "Hold sign-in to your Workspace"). It concerns signers and approvers whose address is in one of those domains, your employees. Anyone else is never asked, and nothing changes for them.

- **Off**: nothing changes.
- **Offer**: an employee sees **Confirm with Google** on the signing page. It is optional.
- **Require**: before the document opens, an employee is asked to **Continue with Google** and comes back signed in to this site. Decided when the envelope is sent and kept with each signer, so changing the setting later does not change the rules an envelope went out under. Correcting an employee's address keeps the requirement.

The check is passed only by a current session of this site that was **signed in with Google** (not a password session of the same account), of the account whose confirmed address is the one the document was sent to. Signing in as someone else, or with a password, is refused and recorded. The signer may need an account here for this: Google sign-in creates one under the site's sign-up rule (set it to your domain, part 1).

It is always on top of what the sender asked for. It never replaces an access code or an emailed code: those prove something else, and the sender chose them.

In the evidence:

- each attempt is in the envelope's audit trail as **verified** or **verification_failed** with the method `google` (and the account, or why it was refused);
- the signature or approval lists it among the checks passed;
- the certificate says **Identified by: possession of the emailed signing link, identity confirmed by Google Workspace sign-in**, and the same for an employee who chose to confirm when it was only offered.

Part 11 envelopes are never asked: their signers already give their account's email address and password for each signature. `GOOGLE_SIGNING` (`off`, `offer` or `require`) sets this from the environment and locks it in Settings.

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
| `DIRECTORY_SYNC`                                      | `on` or `off`: offboarding from the directory            |
| `DIRECTORY_SYNC_MAX_PER_RUN`                          | Most people offboarded per run, 1 to 500 (default 10)    |
| `MANAGER_APPROVAL`                                    | `off`, `suggest` or `require`: the sender's manager rule |
| `GOOGLE_SIGNING`                                      | `off`, `offer` or `require`: employees sign with Google  |

## Troubleshooting

- **"Sign in with your organization's Google Workspace account"**: the account is a personal Google account.
- **"This Google account belongs to a different organization's Workspace"**: its `hd` claim is not one of your Workspace domains. Add the domain if it is yours (a second Workspace).
- **redirect_uri_mismatch** from Google: the redirect URI in the OAuth client is not exactly the one Settings shows. Check `APP_URL`.
- **Test directory access says 403**: the role is not assigned to the service account (it can take a few minutes to apply), the Admin SDK API is not enabled in the project, or, with delegation, a scope is missing.
- **The offboarding run answers `not_configured`**: it is not turned on, or the directory is not (part 2). **`no_domains`**: no Workspace domains are set (part 1). **502 with `stoppedEarly`**: most lookups failed; the failed ones are listed with Google's status, usually the 403 above.
- **"The Google Workspace directory names no manager for you"** when sending: set the user's manager in the Admin console (User information, Manager), or ask your HR sync to. Lookups are cached for a minute.
- **"You are signed in with a password"** on a signing page: the employee is signed in to this site with a password. Sign out, then choose Continue with Google.
- **"This account was suspended or removed in your organization's Google Workspace"** at sign-in: the offboarding job blocked the account. Make the account active in Google again and the next run lifts the block.
