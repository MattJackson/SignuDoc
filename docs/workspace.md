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
