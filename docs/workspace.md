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
