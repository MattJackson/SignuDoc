# SignuDoc with Docker Compose

Runs SignuDoc on a laptop or any host with Docker: the app with a SQLite database in a volume, and a small service that calls the daily jobs. It uses the same image as every other install, configured in the app.

## Start it

```bash
cd examples/docker-compose
cp .env.example .env
```

Fill in `.env`: `BETTER_AUTH_SECRET` and `RETENTION_JOB_SECRET` (each `openssl rand -base64 32`), and `APP_URL`. Then:

```bash
docker compose up -d --build
```

Open the `APP_URL` address (`http://localhost:8080` by default) and follow the onboarding at `/setup`.

## Where the data lives

The database and the documents are in the `signudoc-data` volume, mounted at `/data`. Email is written to `/data/outbox` until you set `EMAIL_DRIVER=resend` and `RESEND_API_KEY`. Run one app container per volume.

Back it up with the app stopped, so the SQLite file is consistent:

```bash
docker compose stop app
docker run --rm -v signudoc-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/signudoc-data.tar.gz -C /data .
docker compose start app
```

The volume name has the project prefix when Compose adds one: check `docker volume ls`. SignuDoc's own backup, set up in the app under Settings, is described in [Backup and restore](../../docs/backup-and-restore.md).

## The daily jobs

The `scheduler` service POSTs `/api/internal/retention`, `/drive-export`, `/notifications` and `/directory-sync` once a day, with `Authorization: Bearer` and `RETENTION_JOB_SECRET`. See the results with `docker compose logs scheduler`.

## What needs a public HTTPS address

`http://localhost:8080` is enough to try the product alone. These need an address other people's browsers and Google can reach, over HTTPS:

- the Gmail and Drive add-on;
- outside signers opening their signing links.

The simplest way from a laptop is a Cloudflare Tunnel. Create one in Cloudflare Zero Trust, point its public hostname at `http://app:8080`, put its token in `.env` as `TUNNEL_TOKEN`, set `APP_URL` to the hostname, and remove the comment marks from the `tunnel` service in `compose.yaml`.

## Google Workspace

Set it up in the app, with Manual or Automatic setup: see [Google Workspace](../../docs/google-workspace.md). It works the same here as on any other host.

### Google Workspace without a key

If the automatic setup says your organization forbids service account keys, run the app with your own gcloud login and let it impersonate the service account the setup made:

```bash
gcloud auth application-default login
```

Then in `compose.yaml`, remove the comment marks from the credentials volume and from `GOOGLE_IMPERSONATE_SERVICE_ACCOUNT` on the `app` service, and set the account in `.env`:

```yaml
volumes:
  - ${HOME}/.config/gcloud/application_default_credentials.json:/home/node/.config/gcloud/application_default_credentials.json:ro
```

```
GOOGLE_IMPERSONATE_SERVICE_ACCOUNT=<name>@<project>.iam.gserviceaccount.com
```

The container runs as the `node` user, whose home is `/home/node`. Your login needs the Service Account Token Creator role on that service account.

## Update

```bash
git pull
docker compose up -d --build
```
