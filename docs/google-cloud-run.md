# Deploy on Google Cloud Run

SignuDoc runs on Google Cloud as one Docker image on [Cloud Run](https://cloud.google.com/run), with a private [Cloud Storage](https://cloud.google.com/storage) bucket for the documents, [Secret Manager](https://cloud.google.com/secret-manager) for its secrets and [Cloud Scheduler](https://cloud.google.com/scheduler) for the scheduled jobs. Nothing about it needs Vercel, and the Vercel deployment keeps working exactly as before.

The database is one of two, chosen with `DB_BACKEND` (see [the design](design/database-backends.md)):

- **SQLite (the default).** One Cloud Run instance with the database as a file on it, copied to a Cloud Storage bucket within about a second of every change by [Litestream](https://litestream.io). There is no database server, so an install nobody is using costs nothing: the instance scales to zero and the next request starts it again from the copy. Right for a rarely used install.
- **Postgres.** [Cloud SQL for PostgreSQL](https://cloud.google.com/sql/docs/postgres), with any number of instances. Right for steady traffic, or more than one instance. About $13 to $30 a month whether it is used or not.

The setup script only provisions the infrastructure and the few settings the app needs to start. Everything else (email, Google sign-in, backups, branding) is set up in the app itself, by the administrator, after the first sign-in.

- [What you get](#what-you-get)
- [Before you start](#before-you-start)
- [Run the setup script](#run-the-setup-script)
- [Set the site up](#set-the-site-up)
- [Your own domain](#your-own-domain)
- [Deploying updates](#deploying-updates)
- [The SQLite database](#the-sqlite-database)
- [Logs and alerts](#logs-and-alerts)
- [Backups](#backups)
- [Switching to Postgres later](#switching-to-postgres-later)
- [The visitor's address](#the-visitors-address)
- [What it costs](#what-it-costs)
- [Troubleshooting](#troubleshooting)
- [Running the image elsewhere](#running-the-image-elsewhere)

## What you get

[`deploy/google-cloud/setup.sh`](../deploy/google-cloud/setup.sh) creates, in one region of your project:

| What                         | Name (with the defaults)                                                               | Notes                                                                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact Registry repository | `signudoc`                                                                             | Holds the images.                                                                                                                                                                                                                                                                                  |
| Runtime service account      | `signudoc-run@<project>.iam.gserviceaccount.com`                                       | The app runs as this. It can read its own secrets and read and write its own buckets (and, on Postgres, connect to Cloud SQL), nothing more.                                                                                                                                                       |
| SQLite replica bucket        | `<project>-signudoc-db`                                                                | SQLite only. Litestream's copy of the database. Object versioning and 7-day soft delete.                                                                                                                                                                                                           |
| Cloud SQL for PostgreSQL 17  | `signudoc-db`, database and user `signudoc`                                            | Postgres only. Enterprise edition, encrypted connections only, deletion protection, daily automated backups kept 14 days and point-in-time recovery over 7 days.                                                                                                                                   |
| Cloud Storage bucket         | `<project>-signudoc-files`                                                             | The documents. Uniform access, public access prevention, 7-day soft delete. The app uses it with `STORAGE_DRIVER=gcs` and `GCS_BUCKET`.                                                                                                                                                            |
| Secrets                      | `signudoc-better-auth-secret`, `signudoc-setup-token`, `signudoc-retention-job-secret` | Generated the first time, never printed, and never replaced on a later run. Postgres adds `signudoc-database-url`.                                                                                                                                                                                 |
| Cloud Run service            | `signudoc`                                                                             | Public, port 8080, scales to zero. Startup and liveness probes on `/api/health`. SQLite: at most one instance, CPU kept on while it runs (see [The SQLite database](#the-sqlite-database)).                                                                                                        |
| Cloud Run job                | `signudoc-migrate`                                                                     | Postgres only: `node db/migrate.mjs` from the same image, run before every deploy. On SQLite the container migrates the database when it starts.                                                                                                                                                   |
| Cloud Scheduler jobs         | `signudoc-retention`, `-directory-sync`, `-drive-export`, `-notifications`             | `POST /api/internal/...` with the job secret as a bearer token: the cleanup daily at 09:00 UTC, the directory sync daily at 07:00, Drive export and notifications daily at 07:45 UTC by default (`FREQUENT_SCHEDULE='*/15 * * * *'` restores 15-minute retries, at the cost described under Cost). |

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
  BACKUP_REGION=us-east1 ./deploy/google-cloud/setup.sh
```

It prints each step and each command as it goes. With SQLite it takes a few minutes, most of it the image build; with `DB_BACKEND=postgres` about 15, most of it Cloud SQL creating the instance. It is safe to run again: whatever already exists is left alone, and the Cloud Run settings it manages are brought up to date. Settings you add to the service yourself are kept.

| Setting                               | Default                       | What it does                                                                                                                                                                                                              |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROJECT_ID`                          | required                      | Your Google Cloud project.                                                                                                                                                                                                |
| `REGION`                              | `us-central1`                 | Where everything lives. For domain mappings, pick a [region that supports them](https://cloud.google.com/run/docs/mapping-custom-domains).                                                                                |
| `DB_BACKEND`                          | `sqlite`                      | `sqlite` or `postgres`.                                                                                                                                                                                                   |
| `DOMAIN`                              | none                          | The site's own address. Without it, the site uses its `run.app` URL.                                                                                                                                                      |
| `SERVICE`                             | `signudoc`                    | The Cloud Run service; the other names are made from it.                                                                                                                                                                  |
| `DB_BUCKET`                           | `<project>-<service>-db`      | SQLite: the replica bucket.                                                                                                                                                                                               |
| `DB_TIER`                             | `db-g1-small`                 | Postgres: the Cloud SQL machine. `db-f1-micro` costs less; `db-custom-1-3840` is a dedicated core with an SLA.                                                                                                            |
| `MIN_INSTANCES` / `MAX_INSTANCES`     | `0` / `4`                     | `MIN_INSTANCES=1` keeps an instance warm so nobody waits for a cold start. On SQLite `MAX_INSTANCES` is always 1. On Postgres each instance holds up to 10 connections, so with `db-f1-micro` keep it at 2.               |
| `BUCKET`                              | `<project>-<service>-files`   | The documents bucket. Bucket names are global, so change it if that one is taken.                                                                                                                                         |
| `BACKUP_REGION`                       | none                          | Turns on the [backup bucket](#backups), in this region.                                                                                                                                                                   |
| `BACKUP_BUCKET`                       | `<project>-<service>-backups` | Its name.                                                                                                                                                                                                                 |
| `FREQUENT_SCHEDULE`                   | `45 7 * * *`                  | Retries for the Drive export and notification jobs, which already run right after each request. Each run starts an instance if none is up, so every 15 minutes keeps one up all day; see [What it costs](#what-it-costs). |
| `GITHUB_REPOSITORY`                   | none                          | `owner/name` of your copy, to [deploy from GitHub Actions](#from-github-actions).                                                                                                                                         |
| `RESEND_API_KEY`, `SSO_CLIENT_SECRET` | none                          | Optional. Stored as secrets and handed to the app. Both can be set up in the app instead.                                                                                                                                 |
| `EXTRA_ENV_VARS`                      | none                          | More app settings, as `KEY=value,KEY=value`, for example `SSO_ISSUER=https://accounts.google.com,SSO_CLIENT_ID=...`. Every setting is listed in [`.env.example`](../.env.example).                                        |
| `IMAGE`                               | none                          | Deploy this image (by digest) instead of building one.                                                                                                                                                                    |
| `USE_LOCAL_DOCKER`                    | none                          | `1` builds with your own Docker instead of Cloud Build.                                                                                                                                                                   |

The service is made public with Cloud Run's [`--no-invoker-iam-check`](https://cloud.google.com/run/docs/securing/managing-access#invoker_check), not an `allUsers` IAM binding, so an organization policy that restricts sharing to your own domain does not stop it. Signers outside your organization have to be able to open it.

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

Each deploy builds an image and switches the service to it by digest. On Postgres the migrations run with that image first, so what was migrated against is exactly what is served. On SQLite the new container runs them itself when it starts, before the server.

### From your machine

```bash
PROJECT_ID=my-project REGION=us-central1 ./deploy/google-cloud/deploy.sh
```

[`deploy.sh`](../deploy/google-cloud/deploy.sh) builds the current checkout with Cloud Build, tags it with the commit, then runs (the first two only on Postgres):

```bash
gcloud run jobs update signudoc-migrate --image=<image@sha256:...>
gcloud run jobs execute signudoc-migrate --wait
gcloud run services update signudoc --image=<image@sha256:...>
```

It tells the backends apart by whether the `signudoc-migrate` job exists; set `DB_BACKEND` to say so yourself.

To take a new SignuDoc release, update your copy first (see [Keep your install up to date](self-hosting.md#keep-your-install-up-to-date)), then deploy. To roll back, deploy the earlier digest with `IMAGE=...`. On Postgres you can also send traffic back to an earlier revision in the Cloud Run console; on SQLite, deploy the earlier image again instead (see [One instance](#one-instance-even-during-a-deploy)). Migrations are not rolled back, so check the release notes before going back past one that changed the database.

### From GitHub Actions

[`.github/workflows/deploy-cloud-run.yml`](../.github/workflows/deploy-cloud-run.yml) does the same from GitHub. It only runs when you start it from the Actions tab, and signs in to Google Cloud through [Workload Identity Federation](https://github.com/google-github-actions/auth#workload-identity-federation-through-a-service-account), so no key is stored anywhere. On SQLite it also sets the service's database, storage and backup settings, secrets and one-instance limits, so a service that was set up by hand is brought in line.

1. Run the setup script with `GITHUB_REPOSITORY=your-org/signudoc`. It creates a workload identity pool and provider that only accept that repository, and a `signudoc-deploy` service account that can push images, update the service and the migrate job, and act as the runtime service account.
2. In your copy on GitHub, under Settings, Secrets and variables, Actions, **Variables**, add:
   - `GCP_PROJECT_ID`: `my-project`
   - `GCP_REGION`: `us-central1`
   - `GCP_WORKLOAD_IDENTITY_PROVIDER`: `projects/<project number>/locations/global/workloadIdentityPools/github/providers/github`
   - `GCP_DEPLOY_SERVICE_ACCOUNT`: `signudoc-deploy@my-project.iam.gserviceaccount.com`
   - `APP_URL`: `https://sign.example.com`. Optional: unset keeps the address the setup script gave the service.
   - `FILES_BUCKET`, `DB_BUCKET` and `SQLITE_PATH`, only on SQLite and only if you gave the setup script others than its defaults. `BACKUP_BUCKET`, only if the setup script made a backup bucket (`BACKUP_REGION`); without it the workflow leaves the backup setting alone.
   - `DB_BACKEND`: `postgres`, only on Postgres.
   - `CLOUD_RUN_SERVICE` and `ARTIFACT_REPOSITORY`, only if you changed `SERVICE` or the repository name.
3. Actions, **Deploy to Cloud Run**, **Run workflow**, and pick the branch.

None of these values is a secret. The project number is shown by `gcloud projects describe my-project --format='value(projectNumber)'`.

## The SQLite database

The image starts through [`db/sqlite/start.mjs`](../db/sqlite/start.mjs) when `DATABASE_URL` is `sqlite:/data/signudoc.db` and `LITESTREAM_REPLICA_URL` is `gs://<project>-signudoc-db/db`:

1. It takes the database's lease (below).
2. `litestream restore` brings the database back from the bucket. On the very first start the bucket is empty and the database starts empty.
3. The migrations run.
4. `litestream replicate -exec "node server.js"` starts the server, and from then on copies every committed change to the bucket.

### How much can be lost

- Every commit is on the instance's disk before it is acknowledged, and in the bucket within about a second (Litestream's sync interval, `LITESTREAM_SYNC_INTERVAL`).
- A normal stop loses nothing: scaling to zero, a deploy, a crash of the server process. Cloud Run sends SIGTERM; the server stops; Litestream syncs what is left and exits, within Cloud Run's 10 seconds.
- An instance lost without warning (a host failure) can lose the last second or so of changes.
- `--no-cpu-throttling` keeps the CPU on while the instance is up, so the copying does not wait for the next request. The instance still scales to zero when idle. The database lives in the instance's memory-backed disk, so it counts against the service's 1 GiB of memory; an install with hundreds of megabytes of database rows should raise `--memory`.

### One instance, even during a deploy

The database is a file on one machine, and only one process may write it. `--max-instances=1` keeps Cloud Run to one instance per revision, but during a deploy the new revision starts while the old one still serves. So the start script holds a lease, a small object `db.lease` beside the replica, written with Cloud Storage generation checks:

- The new instance waits for it, answering `/api/health` (so the deploy goes ahead) and every other request with a short "starting up" 503. Being a newer revision, it asks the old instance to hand over; the old one stops its server, finishes its last sync and lets go. The new one then restores from that sync, so nothing written to the old revision is lost. A deploy costs a few seconds of 503s.
- A lease nobody has refreshed for 30 seconds belonged to an instance that died; the next instance takes it over.
- An older revision never takes the lease from a newer one, which is why rolling back means deploying the older image again, not sending traffic to the older revision.

The lease is only used with a `gs://` replica. `LITESTREAM_LEASE=off` turns it off; do that only where nothing can start a second instance.

### Point-in-time restore

Litestream keeps every change since the oldest snapshot it keeps (7 days by default, `LITESTREAM_RETENTION`), so the database can be brought back as it was at any moment in that window. On your machine, with [Litestream installed](https://litestream.io/install/) and `gcloud auth application-default login`:

```bash
litestream restore -timestamp 2026-11-18T09:30:00Z -o signudoc.db gs://my-project-signudoc-db/db
sqlite3 signudoc.db "select count(*) from envelopes"     # look before you put it back
```

To put it back, push the restored file to a new path in the bucket and point the service at it. The old path stays as it was, so this can be undone by pointing back:

```bash
cat > litestream.yml <<'YAML'
dbs:
  - path: signudoc.db
    replica:
      url: gs://my-project-signudoc-db/db-restored-20261118
YAML
litestream replicate -config litestream.yml -once -force-snapshot
gcloud run services update signudoc --region=us-central1 \
  --update-env-vars=LITESTREAM_REPLICA_URL=gs://my-project-signudoc-db/db-restored-20261118
```

The new revision starts from the restored copy. Anything written to the old revision after the moment you restored to is not in it, which is the point of going back; look at the old path first if you need something from it.

## Logs and alerts

On Cloud Run, the app's structured log lines (security events and the audit copies described in [Send the audit trail to your SIEM](self-hosting.md#send-the-audit-trail-to-your-siem)) carry a `severity` field, so [Cloud Logging](https://cloud.google.com/logging/docs/structured-logging) files them at the right level. Elsewhere the lines are unchanged. In the Logs Explorer:

```text
resource.type="cloud_run_revision"
resource.labels.service_name="signudoc"
severity>=ERROR
```

Two alerts are worth setting up:

- **Errors.** A [log-based alert](https://cloud.google.com/logging/docs/alerting/log-based-alerts) on the query above tells you about failed jobs, failed emails and server errors. In the Logs Explorer, run the query, then **Actions, Create log alert**, and pick a notification channel. Limit it to one notification every few minutes so a burst does not flood you. On SQLite, also alert on `textPayload:"litestream" AND severity>=WARNING`, which shows replication trouble.
- **Uptime.** An [uptime check](https://cloud.google.com/monitoring/uptime-checks) on `https://sign.example.com/api/health` with an alert on failure tells you when the site is down. `/api/health` answers as soon as the server is running and does not touch the database, so it is cheap to call, but on SQLite every call keeps the instance up; check every 15 minutes or more, or the install never scales to zero.

  ```bash
  gcloud monitoring uptime create signudoc --project=my-project \
    --resource-type=uptime-url \
    --resource-labels=host=sign.example.com,project_id=my-project \
    --path=/api/health --period=15
  ```

To send the audit lines to a SIEM, create a [log sink](https://cloud.google.com/logging/docs/export/configure_export_v2) with the filter `jsonPayload.source="signudoc"`. `AUDIT_LOG=off` keeps the audit copies out of the logs.

## Backups

- **The database, on SQLite.** The replica bucket is a continuous backup: [point-in-time restore](#point-in-time-restore) to any moment of the last 7 days, with object versioning and soft delete on the bucket itself.
- **The database, on Postgres.** Cloud SQL takes a backup every day and keeps 14, and point-in-time recovery lets you restore to any second of the last 7 days. Restore into a new instance from the Cloud SQL console (Backups), or with `gcloud sql instances clone signudoc-db signudoc-db-restored --point-in-time=<timestamp>`, then point the `signudoc-database-url` secret at it.
- **The documents.** The bucket keeps deleted files for 7 days (soft delete), so a mistaken deletion can be undone with `gcloud storage restore`.
- **A copy elsewhere.** With `BACKUP_REGION` set, the script also creates a second bucket in that region with object versioning, gives the runtime service account access to it, sets `BACKUP_GCS_BUCKET`, and schedules `POST /api/internal/backup` once a day at 08:00 UTC with the job secret. Pick a region other than `REGION`, so one region's outage does not take both copies. This is SignuDoc's own backup, the same on both databases: every table as one file, read in one snapshot, and the documents. [Backup and restore](backup-and-restore.md) covers what it contains and how to restore it.

## Switching to Postgres later

[`scripts/transfer-database.ts`](../scripts/transfer-database.ts) copies every row from one database into another, empty one, of either kind. It is SignuDoc's own backup and restore with nothing in between, so it checks what a restore checks: the target is migrated first, must have no accounts yet, and gets everything in one transaction or nothing. The documents stay where they are, in the same bucket. With [Litestream](https://litestream.io/install/) and the [Cloud SQL Auth Proxy](https://cloud.google.com/sql/docs/postgres/sql-proxy) installed, and `gcloud auth application-default login`:

1. Close the site to the outside, so nothing changes while it is copied (this also holds back the scheduled jobs), and wait a minute for the last changes to reach the bucket:

   ```bash
   gcloud run services update signudoc --region=us-central1 --ingress=internal
   ```

2. Take the latest copy of the database:

   ```bash
   litestream restore -o signudoc.db gs://my-project-signudoc-db/db
   ```

3. Drop the SQLite settings, then let the setup script create Cloud SQL, its secret and the migrate job, migrate the new database and deploy (the site stays closed):

   ```bash
   gcloud run services update signudoc --region=us-central1 \
     --remove-env-vars=DATABASE_URL,LITESTREAM_REPLICA_URL
   DB_BACKEND=postgres PROJECT_ID=my-project REGION=us-central1 DOMAIN=sign.example.com \
     ./deploy/google-cloud/setup.sh
   ```

4. Copy the rows across, through the proxy. The password is the one in the `signudoc-database-url` secret:

   ```bash
   cloud-sql-proxy my-project:us-central1:signudoc-db --port 5432 &
   npm run transfer-database -- --from sqlite:signudoc.db \
     --to "postgres://signudoc:<password>@127.0.0.1:5432/signudoc"
   ```

5. Open the site again, and tell the deploy workflow (repository variable `DB_BACKEND=postgres`):

   ```bash
   gcloud run services update signudoc --region=us-central1 --ingress=all
   ```

The replica bucket can be deleted once you are happy. Going from Postgres to SQLite is the same the other way round: close the site, `npm run transfer-database -- --from "postgres://…" --to sqlite:signudoc.db`, push `signudoc.db` to the replica path as in [Point-in-time restore](#point-in-time-restore), remove the `DATABASE_URL` secret from the service (`--remove-secrets=DATABASE_URL`), and run the setup script with `DB_BACKEND=sqlite`.

## The visitor's address

Rate limits, sessions and the audit trail record each visitor's IP address. Off Vercel, SignuDoc reads it from the `X-Forwarded-For` header, counting from the right, because each proxy appends the address it saw and anything to the left of that came from the visitor and can be made up.

- **On Cloud Run** (its `run.app` address or a domain mapping), Google's front end appends the visitor's address as the last entry, which is what SignuDoc reads by default. Nothing to set.
- **Behind a Google Cloud external Application Load Balancer**, the load balancer appends two entries, the visitor and its own address, so set `TRUSTED_PROXY_HOPS=2` (with `EXTRA_ENV_VARS`, or `gcloud run services update signudoc --update-env-vars=TRUSTED_PROXY_HOPS=2`). Also set the service's ingress to "internal and Cloud Load Balancing", so nobody can reach it around the load balancer.
- **Behind Cloudflare's proxy**, or another proxy that writes one header with the visitor's address and replaces any the visitor sent, set `CLIENT_IP_HEADER` to that header, for example `CLIENT_IP_HEADER=cf-connecting-ip`. Only do that when every request comes through that proxy.

## What it costs

A rough monthly figure for a small organization in `us-central1`, before taxes. Prices change, so check the [pricing calculator](https://cloud.google.com/products/calculator) for your region.

| Item                                               | SQLite                                | Postgres                                      |
| -------------------------------------------------- | ------------------------------------- | --------------------------------------------- |
| Database                                           | $0 (a few MB in the replica bucket)   | $28 for `db-g1-small` ($11 for `db-f1-micro`) |
| Cloud Run, a few thousand requests a day           | $0 to $5, mostly within the free tier | $0 to $5                                      |
| Cloud Storage, a few GB of PDFs                    | under $1                              | under $1                                      |
| Secret Manager, Cloud Scheduler, Artifact Registry | under $1                              | under $1                                      |
| **Total while nobody uses it**                     | **about $0** (see below)              | **about $30** (about $13 with `db-f1-micro`)  |

On SQLite the CPU stays on while an instance is up (`--no-cpu-throttling`), so you pay for the whole time it is up, not only while it answers: each wake-up keeps it for up to about 15 minutes. The Drive export and notification jobs wake it once a day by default (07:45 UTC). Setting `FREQUENT_SCHEDULE='*/15 * * * *'` for 15-minute retries keeps an instance up around the clock (roughly $40 to $50 a month for 1 vCPU and 1 GiB). If you do not use Drive export or chat notifications, or can wait longer for them, set `FREQUENT_SCHEDULE` to something like `0 * * * *` (hourly) or `0 8-18 * * 1-5` (working hours), or pause those two jobs in Cloud Scheduler. `MIN_INSTANCES=1` keeps one instance warm at all times, about the same cost.

Email is extra and billed by your email provider, such as Resend.

## Troubleshooting

- **The service is not public.** The script deploys with `--no-invoker-iam-check`, which needs a gcloud from 2025 or later and permission to change the service's settings (Cloud Run Admin). If your organization forbids even that, ask an organization admin for an exception for this project, since a signing site has to be reachable by signers outside your organization.
- **Cloud Build fails with permission denied.** The script grants Cloud Build's service account what it needs to push to the repository, but an organization policy can stop that. Run the script with `USE_LOCAL_DOCKER=1` to build with your own Docker, or build elsewhere and pass `IMAGE=<image@sha256:...>`.
- **The migrate job fails (Postgres).** Read its log: `gcloud run jobs executions list --job=signudoc-migrate --region=us-central1`, then open the execution in the console. A failed migration is rolled back, and the service is not updated until the job succeeds.
- **The new revision never becomes ready.** The startup probe calls `/api/health` for up to two minutes. Open the revision's logs: a missing secret, or a Cloud SQL instance that is still starting, is the usual reason. On SQLite, `[start]` lines show the lease, the restore and the migrations; a failed migration stops the container before the server starts, and the old revision keeps serving.
- **Every request answers "Starting up" (SQLite).** The instance is waiting for the database lease. `[lease] held by …` in its log names the holder. After a crash it waits 30 seconds. If an older revision keeps it (a rollback by traffic), send all traffic to the newest revision, or deploy again.
- **Sign-in fails with an invalid origin.** The site is being opened on an address other than `APP_URL`, for example the `run.app` address after a domain was set. Use the domain, or run the script again without `DOMAIN`.
- **The domain mapping stays at "Certificate provisioning".** The DNS record is missing, wrong, or proxied. `dig sign.example.com CNAME` should answer `ghs.googlehosted.com.`
- **Everyone shares one rate limit.** The app is behind a load balancer or proxy it does not know about; see [The visitor's address](#the-visitors-address).
- **Too many database connections (Postgres).** Lower `MAX_INSTANCES`, or choose a larger `DB_TIER`.

## Running the image elsewhere

The [`Dockerfile`](../Dockerfile) builds a Next.js standalone server that runs as a non-root user and listens on `$PORT` (8080 by default). With a Postgres `DATABASE_URL` it starts the server as before, and the same image runs the migrations:

```bash
docker run --env-file .env -p 8080:8080 <image>            # the app
docker run --env-file .env <image> node db/migrate.mjs     # the migrations
```

With `DATABASE_URL=sqlite:/data/signudoc.db` it migrates the database itself at start. Keep `/data` on a volume, and either back it up yourself or set `LITESTREAM_REPLICA_URL` (any [Litestream replica URL](https://litestream.io/reference/config/#replica-settings), for example `s3://` or `file:///backup/signudoc`). Run only one container on one database file.

`docker compose --profile app up --build` runs it locally against the Compose database, with files on a volume and email written to `/data/outbox`; see [`docker-compose.yml`](../docker-compose.yml). Anywhere else, the settings in [Self-hosting somewhere else](self-hosting.md#self-hosting-somewhere-else) apply.
