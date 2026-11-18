# Google Workspace

SignuDoc works with any organization's Google Workspace. Once it is set up, anyone at the organization signs in with their Google account and can send documents straight away: a salesperson types a customer's address and picks their manager from the directory as a second signer. Administrators can be managed with a Google Group.

Everything here is set in the app, in Settings, Google Workspace, and in the same steps of onboarding (`/onboarding`, where first-run setup ends). Each part is a checklist with live checks and this site's own values to paste into Google's consoles. Every setting also has an environment variable; one that is set wins, and the app shows the setting as fixed.

There are three parts. Only the first is needed for sign-in.

1. [Google sign-in](#1-google-sign-in)
2. [The Workspace directory](#2-the-workspace-directory): suggest colleagues as recipients
3. [An administrator group](#3-an-administrator-group)

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

## Troubleshooting

- **"Sign in with your organization's Google Workspace account"**: the account is a personal Google account.
- **"This Google account belongs to a different organization's Workspace"**: its `hd` claim is not one of your Workspace domains. Add the domain if it is yours (a second Workspace).
- **redirect_uri_mismatch** from Google: the redirect URI in the OAuth client is not exactly the one Settings shows. Check `APP_URL`.
- **Test directory access says 403**: the role is not assigned to the service account (it can take a few minutes to apply), the Admin SDK API is not enabled in the project, or, with delegation, a scope is missing.
