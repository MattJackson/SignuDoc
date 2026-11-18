# Deploy on Google Cloud Run

SignuDoc runs on Google Cloud as one Docker image on [Cloud Run](https://cloud.google.com/run), with [Cloud SQL for PostgreSQL](https://cloud.google.com/sql/docs/postgres) for the database, a private [Cloud Storage](https://cloud.google.com/storage) bucket for the documents, [Secret Manager](https://cloud.google.com/secret-manager) for its secrets and [Cloud Scheduler](https://cloud.google.com/scheduler) for the daily jobs. Nothing about it needs Vercel, and the Vercel deployment keeps working exactly as before.

The setup script only provisions the infrastructure and the few settings the app needs to start. Everything else (email, Google sign-in, backups, branding) is set up in the app itself, by the administrator, after the first sign-in.

- [What you get](#what-you-get)
- [Before you start](#before-you-start)
- [Run the setup script](#run-the-setup-script)
- [Set the site up](#set-the-site-up)
- [Your own domain](#your-own-domain)
- [Deploying updates](#deploying-updates)
- [Logs and alerts](#logs-and-alerts)
- [Backups](#backups)
- [The visitor's address](#the-visitors-address)
- [What it costs](#what-it-costs)
- [Troubleshooting](#troubleshooting)
- [Running the image elsewhere](#running-the-image-elsewhere)

## What you get

[`deploy/google-cloud/setup.sh`](../deploy/google-cloud/setup.sh) creates, in one region of your project:

| What                         | Name (with the defaults)                                                                                        | Notes                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact Registry repository | `signudoc`                                                                                                      | Holds the images.                                                                                                                                 |
| Runtime service account      | `signudoc-run@<project>.iam.gserviceaccount.com`                                                                | The app runs as this. It can connect to Cloud SQL, read its own secrets, and read and write its own bucket, nothing more.                         |
| Cloud SQL for PostgreSQL 17  | `signudoc-db`, database and user `signudoc`                                                                     | Enterprise edition, encrypted connections only, deletion protection, daily automated backups kept 14 days and point-in-time recovery over 7 days. |
| Cloud Storage bucket         | `<project>-signudoc-files`                                                                                      | Uniform access, public access prevention, 7-day soft delete. The app uses it with `STORAGE_DRIVER=gcs` and `GCS_BUCKET`.                          |
| Secrets                      | `signudoc-database-url`, `signudoc-better-auth-secret`, `signudoc-setup-token`, `signudoc-retention-job-secret` | Generated the first time, never printed, and never replaced on a later run.                                                                       |
| Cloud Run service            | `signudoc`                                                                                                      | Public, port 8080, scales to zero by default. Startup and liveness probes on `/api/health`.                                                       |
| Cloud Run job                | `signudoc-migrate`                                                                                              | `node db/migrate.mjs` from the same image, run before every deploy.                                                                               |
| Cloud Scheduler job          | `signudoc-retention`                                                                                            | `POST /api/internal/retention` once a day at 09:00 UTC with the job secret as a bearer token. See [Daily cleanup](self-hosting.md#daily-cleanup). |

And, when you ask for them: a backup bucket in a second region and its daily job (`BACKUP_REGION`), a domain mapping (`DOMAIN`), secrets for a Resend key and a single sign-on client secret (`RESEND_API_KEY`, `SSO_CLIENT_SECRET`), and Workload Identity Federation for the GitHub deploy workflow (`GITHUB_REPOSITORY`).

## Before you start

- A Google Cloud project with billing turned on, and an account that is an Owner of it (or holds enough admin roles to enable APIs, create service accounts and grant IAM roles).
- The [gcloud CLI](https://cloud.google.com/sdk/docs/install), signed in: `gcloud auth login`. Domain mappings use `gcloud beta`, which gcloud offers to install the first time.
- `openssl` and `bash`, which macOS and Linux have.
- A copy of this repository. The image is built from it by Cloud Build, so you do not need Docker.

## Run the setup script

From the root of your copy:

```bash
PROJECT_ID=my-project REGION=us-central1 DOMAIN=sign.example.com \
  ./deploy/google-cloud/setup.sh
```

It prints each step and each command as it goes, and takes about 15 minutes the first time, most of it Cloud SQL creating the instance. It is safe to run again: whatever already exists is left alone, and the Cloud Run settings it manages are brought up to date. Settings you add to the service yourself are kept.

| Setting                               | Default                       | What it does                                                                                                                                                                                    |
| ------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_ID`                          | required                      | Your Google Cloud project.                                                                                                                                                                      |
| `REGION`                              | `us-central1`                 | Where everything lives. For domain mappings, pick a [region that supports them](https://cloud.google.com/run/docs/mapping-custom-domains).                                                      |
| `DOMAIN`                              | none                          | The site's own address. Without it, the site uses its `run.app` URL.                                                                                                                            |
| `SERVICE`                             | `signudoc`                    | The Cloud Run service; the other names are made from it.                                                                                                                                        |
| `DB_TIER`                             | `db-g1-small`                 | The Cloud SQL machine. `db-f1-micro` costs less; `db-custom-1-3840` is a dedicated core with an SLA.                                                                                            |
| `MIN_INSTANCES` / `MAX_INSTANCES`     | `0` / `4`                     | `MIN_INSTANCES=1` keeps an instance warm so nobody waits for a cold start. Each instance holds up to 10 database connections, so with `db-f1-micro` (25 connections) keep `MAX_INSTANCES` at 2. |
| `BUCKET`                              | `<project>-<service>-files`   | The documents bucket. Bucket names are global, so change it if that one is taken.                                                                                                               |
| `BACKUP_REGION`                       | none                          | Turns on the [backup bucket](#backups), in this region.                                                                                                                                         |
| `BACKUP_BUCKET`                       | `<project>-<service>-backups` | Its name.                                                                                                                                                                                       |
| `GITHUB_REPOSITORY`                   | none                          | `owner/name` of your copy, to [deploy from GitHub Actions](#from-github-actions).                                                                                                               |
| `RESEND_API_KEY`, `SSO_CLIENT_SECRET` | none                          | Optional. Stored as secrets and handed to the app. Both can be set up in the app instead.                                                                                                       |
| `EXTRA_ENV_VARS`                      | none                          | More app settings, as `KEY=value,KEY=value`, for example `SSO_ISSUER=https://accounts.google.com,SSO_CLIENT_ID=...`. Every setting is listed in [`.env.example`](../.env.example).              |
| `IMAGE`                               | none                          | Deploy this image (by digest) instead of building one.                                                                                                                                          |
| `USE_LOCAL_DOCKER`                    | none                          | `1` builds with your own Docker instead of Cloud Build.                                                                                                                                         |

## Set the site up

When the script finishes it prints the site's address and the command that reads the setup token:

```bash
gcloud secrets versions access latest --secret=signudoc-setup-token --project=my-project
```

Open `https://sign.example.com/setup` (or the `run.app` address if you have no domain yet), give the token, and follow the onboarding: name your organization, create the administrator account, then set up email, sign-in and backups from Settings. The token is what stops whoever finds the address first from taking the install.

## Your own domain

With `DOMAIN` set, the script creates a [Cloud Run domain mapping](https://cloud.google.com/run/docs/mapping-custom-domains) and prints the DNS record to add. For a subdomain such as `sign.example.com` it is a `CNAME` to `ghs.googlehosted.com.`

- Add the record at your DNS host as **DNS only**. If your DNS host is a proxy, such as Cloudflare with the orange cloud on, turn the proxy off for this record: Google has to see its own record to issue the certificate.
- Google must know you own the domain first. If the mapping is refused, run `gcloud domains verify example.com` and follow the steps, then run the script again.
- The certificate is issued by itself once the record resolves, usually within 15 to 60 minutes. Until then the site answers on its `run.app` address.

`APP_URL` is set to `https://<DOMAIN>`, so sign-in works on that address only. To add a domain later, run the script again with `DOMAIN` set.

Domain mappings are not offered in every region. Where they are not, or for Cloud Armor or a CDN, put a [global external Application Load Balancer](https://cloud.google.com/run/docs/integrate/custom-domain-load-balancer) in front of the service instead, and read [The visitor's address](#the-visitors-address).

## Deploying updates

Each deploy builds an image, runs the migrations with that image, then switches the service to it by digest, so what was migrated against is exactly what is served.

### From your machine

```bash
PROJECT_ID=my-project REGION=us-central1 ./deploy/google-cloud/deploy.sh
```

[`deploy.sh`](../deploy/google-cloud/deploy.sh) builds the current checkout with Cloud Build, tags it with the commit, then runs:

```bash
gcloud run jobs update signudoc-migrate --image=<image@sha256:...>
gcloud run jobs execute signudoc-migrate --wait
gcloud run services update signudoc --image=<image@sha256:...>
```

To take a new SignuDoc release, update your copy first (see [Keep your install up to date](self-hosting.md#keep-your-install-up-to-date)), then deploy. To roll back, deploy the earlier digest with `IMAGE=...`, or send traffic back to an earlier revision in the Cloud Run console. Migrations are not rolled back, so check the release notes before going back past one that changed the database.

### From GitHub Actions

[`.github/workflows/deploy-cloud-run.yml`](../.github/workflows/deploy-cloud-run.yml) does the same from GitHub. It only runs when you start it from the Actions tab, and signs in to Google Cloud through [Workload Identity Federation](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account), so no key is stored anywhere.

1. Run the setup script with `GITHUB_REPOSITORY=your-org/signudoc`. It creates a workload identity pool and provider that only accept that repository, and a `signudoc-deploy` service account that can push images, update the service and the migrate job, and act as the runtime service account.
2. In your copy on GitHub, under Settings, Secrets and variables, Actions, **Variables**, add:
   - `GCP_PROJECT_ID`: `my-project`
   - `GCP_REGION`: `us-central1`
   - `GCP_WORKLOAD_IDENTITY_PROVIDER`: `projects/<project number>/locations/global/workloadIdentityPools/github/providers/github`
   - `GCP_DEPLOY_SERVICE_ACCOUNT`: `signudoc-deploy@my-project.iam.gserviceaccount.com`
   - `CLOUD_RUN_SERVICE` and `ARTIFACT_REPOSITORY`, only if you changed `SERVICE` or the repository name.
3. Actions, **Deploy to Cloud Run**, **Run workflow**, and pick the branch.

None of these values is a secret. The project number is shown by `gcloud projects describe my-project --format='value(projectNumber)'`.

## Logs and alerts

On Cloud Run, the app's structured log lines (security events and the audit copies described in [Send the audit trail to your SIEM](self-hosting.md#send-the-audit-trail-to-your-siem)) carry a `severity` field, so [Cloud Logging](https://cloud.google.com/logging/docs/structured-logging) files them at the right level. Elsewhere the lines are unchanged. In the Logs Explorer:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="signudoc"
severity>=ERROR
```

Two alerts are worth setting up:

- **Errors.** A [log-based alert](https://cloud.google.com/logging/docs/alerting/log-based-alerts) on the query above tells you about failed jobs, failed emails and server errors. In the Logs Explorer, run the query, then **Actions, Create log alert**, and pick a notification channel. Limit it to one notification every few minutes so a burst does not flood you.
- **Uptime.** An [uptime check](https://cloud.google.com/monitoring/uptime-checks) on `https://sign.example.com/api/health` with an alert on failure tells you when the site is down. `/api/health` answers as soon as the server is running and does not touch the database, so it is cheap to call every minute:

  ```bash
  gcloud monitoring uptime create signudoc --project=my-project \
    --resource-type=uptime-url \
    --resource-labels=host=sign.example.com,project_id=my-project \
    --path=/api/health --period=5
  ```

To send the audit lines to a SIEM, create a [log sink](https://cloud.google.com/logging/docs/export/configure_export_v2) with the filter `jsonPayload.source="signudoc"`. `AUDIT_LOG=off` keeps the audit copies out of the logs.

## Backups

- **The database.** Cloud SQL takes a backup every day and keeps 14, and point-in-time recovery lets you restore to any second of the last 7 days. Restore into a new instance from the Cloud SQL console (Backups), or with `gcloud sql instances clone signudoc-db signudoc-db-restored --point-in-time=<timestamp>`, then point the `signudoc-database-url` secret at it.
- **The documents.** The bucket keeps deleted files for 7 days (soft delete), so a mistaken deletion can be undone with `gcloud storage restore`.
- **A copy elsewhere.** With `BACKUP_REGION` set, the script also creates a second bucket in that region with object versioning, gives the runtime service account access to it, sets `BACKUP_GCS_BUCKET`, and schedules `POST /api/internal/backup` once a day at 08:00 UTC with the job secret. Pick a region other than `REGION`, so one region's outage does not take both copies. [Backup and restore](backup-and-restore.md) covers what the backup contains and how to restore it.

## The visitor's address

Rate limits, sessions and the audit trail record each visitor's IP address. Off Vercel, SignuDoc reads it from the `X-Forwarded-For` header, counting from the right, because each proxy appends the address it saw and anything to the left of that came from the visitor and can be made up.

- **On Cloud Run** (its `run.app` address or a domain mapping), Google's front end appends the visitor's address as the last entry, which is what SignuDoc reads by default. Nothing to set.
- **Behind a Google Cloud external Application Load Balancer**, the load balancer appends two entries, the visitor and its own address, so set `TRUSTED_PROXY_HOPS=2` (with `EXTRA_ENV_VARS`, or `gcloud run services update signudoc --update-env-vars=TRUSTED_PROXY_HOPS=2`). Also set the service's ingress to "internal and Cloud Load Balancing", so nobody can reach it around the load balancer.
- **Behind Cloudflare's proxy**, or another proxy that writes one header with the visitor's address and replaces any the visitor sent, set `CLIENT_IP_HEADER` to that header, for example `CLIENT_IP_HEADER=cf-connecting-ip`. Only do that when every request comes through that proxy.

## What it costs

A rough monthly figure for a small organization in `us-central1`, before taxes. Prices change, so check the [pricing calculator](https://cloud.google.com/products/calculator) for your region.

| Item                                                      | About                                        |
| --------------------------------------------------------- | -------------------------------------------- |
| Cloud SQL `db-g1-small`, 10 GB SSD, backups               | $28 (`db-f1-micro`: $11)                     |
| Cloud Run, scaling to zero, a few thousand requests a day | $0 to $5, mostly within the free tier        |
| Cloud Run with `MIN_INSTANCES=1`                          | about $10 to $20 more                        |
| Cloud Storage, a few GB of PDFs                           | under $1                                     |
| Secret Manager, Cloud Scheduler, Artifact Registry        | under $1                                     |
| **Total**                                                 | **about $30** (about $13 with `db-f1-micro`) |

Email is extra and billed by your email provider, such as Resend.

## Troubleshooting

- **`--allow-unauthenticated` fails with a policy error.** Your organization's "Domain restricted sharing" policy forbids public services. Ask an organization admin for an exception for this project, since a signing site has to be reachable by signers outside your organization.
- **Cloud Build fails with permission denied.** The script grants Cloud Build's service account what it needs to push to the repository, but an organization policy can stop that. Run the script with `USE_LOCAL_DOCKER=1` to build with your own Docker, or build elsewhere and pass `IMAGE=<image@sha256:...>`.
- **The migrate job fails.** Read its log: `gcloud run jobs executions list --job=signudoc-migrate --region=us-central1`, then open the execution in the console. A failed migration is rolled back, and the service is not updated until the job succeeds.
- **The new revision never becomes ready.** The startup probe calls `/api/health` for up to two minutes. Open the revision's logs: a missing secret, or a Cloud SQL instance that is still starting, is the usual reason.
- **Sign-in fails with an invalid origin.** The site is being opened on an address other than `APP_URL`, for example the `run.app` address after a domain was set. Use the domain, or run the script again without `DOMAIN`.
- **The domain mapping stays at "Certificate provisioning".** The DNS record is missing, wrong, or proxied. `dig sign.example.com CNAME` should answer `ghs.googlehosted.com.`
- **Everyone shares one rate limit.** The app is behind a load balancer or proxy it does not know about; see [The visitor's address](#the-visitors-address).
- **Too many database connections.** Lower `MAX_INSTANCES`, or choose a larger `DB_TIER`.

## Running the image elsewhere

The [`Dockerfile`](../Dockerfile) builds a Next.js standalone server that runs as a non-root user and listens on `$PORT` (8080 by default). The same image runs the migrations:

```bash
docker run --env-file .env -p 8080:8080 <image>            # the app
docker run --env-file .env <image> node db/migrate.mjs     # the migrations
```

`docker compose --profile app up --build` runs it locally against the Compose database, with files on a volume and email written to `/data/outbox`; see [`docker-compose.yml`](../docker-compose.yml). Anywhere else, the settings in [Self-hosting somewhere else](self-hosting.md#self-hosting-somewhere-else) apply.
