#!/usr/bin/env bash
# Sets up SignuDoc on Google Cloud Run: everything the app needs to start,
# then builds the image, runs the migrations and deploys it. Safe to run
# again: whatever exists already is left as it is, or brought up to date.
# See docs/google-cloud-run.md.
#
#   PROJECT_ID=my-project REGION=us-central1 DOMAIN=sign.example.com \
#     ./deploy/google-cloud/setup.sh
#
# Settings (environment variables):
#   PROJECT_ID          required. The Google Cloud project.
#   REGION              us-central1. Cloud Run, Cloud SQL, the bucket and the
#                       image all live here.
#   DOMAIN              optional. The site's own web address, mapped to the
#                       service. Without it the site uses its run.app URL.
#   SERVICE             signudoc. The Cloud Run service; other names derive
#                       from it.
#   DB_TIER             db-g1-small. The Cloud SQL machine (db-f1-micro is
#                       cheaper, db-custom-1-3840 is a dedicated core).
#   BUCKET              <PROJECT_ID>-<SERVICE>-files. Where documents are kept.
#   BACKUP_REGION       optional. Turns on a backup bucket in this region
#                       (pick a different one from REGION), and its daily job.
#   BACKUP_BUCKET       <PROJECT_ID>-<SERVICE>-backups.
#   GITHUB_REPOSITORY   optional, owner/name. Lets that repository's
#                       deploy-cloud-run.yml workflow deploy, through Workload
#                       Identity Federation (no key).
#   RESEND_API_KEY, SSO_CLIENT_SECRET
#                       optional. Stored as secrets and given to the app.
#                       Both can instead be set up in the app after sign-in.
#   EXTRA_ENV_VARS      optional, KEY=value,KEY=value. More app settings.
#   MIN_INSTANCES       0. 1 keeps one instance warm (no cold starts, costs more).
#   MAX_INSTANCES       4.
#   IMAGE               optional. Deploy this image instead of building one.
#   USE_LOCAL_DOCKER=1  build with this machine's Docker, not Cloud Build.
set -euo pipefail

# shellcheck source=deploy/google-cloud/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

DB_INSTANCE="${DB_INSTANCE:-${SERVICE}-db}"
DB_TIER="${DB_TIER:-db-g1-small}"
DB_NAME="${DB_NAME:-signudoc}"
DB_USER="${DB_USER:-signudoc}"
BUCKET="${BUCKET:-${PROJECT_ID}-${SERVICE}-files}"
BACKUP_BUCKET="${BACKUP_BUCKET:-${PROJECT_ID}-${SERVICE}-backups}"
DEPLOY_SA="${SERVICE}-deploy@${PROJECT_ID}.iam.gserviceaccount.com"
SQL_CONNECTION="${PROJECT_ID}:${REGION}:${DB_INSTANCE}"
PROJECT_NUMBER="$(gc projects describe "${PROJECT_ID}" --format='value(projectNumber)')"
RUN_URL="https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app"
APP_URL="${DOMAIN:+https://${DOMAIN}}"
APP_URL="${APP_URL:-${RUN_URL}}"

secret_name() { printf '%s-%s' "${SERVICE}" "$1"; }

has_secret_value() {
  [[ -n "$(gc secrets versions list "$1" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]]
}

# Creates the secret if it is missing. With a value, stores it unless the
# latest version already holds it. The value is never printed.
put_secret() {
  local name="$1" value="${2:-}"

  if ! exists secrets describe "${name}"; then
    cmd secrets create "${name}" --replication-policy=automatic
  fi

  if [[ -n "${value}" ]] && ! { has_secret_value "${name}" &&
    [[ "$(gc secrets versions access latest --secret="${name}")" == "${value}" ]]; }; then
    printf '  + gcloud secrets versions add %s (value not shown)\n' "${name}"
    printf '%s' "${value}" | gc secrets versions add "${name}" --data-file=- >/dev/null
  fi

  gc secrets add-iam-policy-binding "${name}" --member="serviceAccount:${RUNTIME_SA}" \
    --role=roles/secretmanager.secretAccessor >/dev/null
}

# A random value, stored only the first time.
put_generated_secret() {
  local name="$1"

  if has_secret_value "${name}"; then
    put_secret "${name}"
  else
    put_secret "${name}" "$(openssl rand -hex 32)"
  fi
}

step "Enabling APIs"
cmd services enable run.googleapis.com sqladmin.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com \
  iamcredentials.googleapis.com storage.googleapis.com

step "Artifact Registry repository ${REPOSITORY}"
exists artifacts repositories describe "${REPOSITORY}" --location="${REGION}" ||
  cmd artifacts repositories create "${REPOSITORY}" --location="${REGION}" \
    --repository-format=docker --description="SignuDoc images"

step "Runtime service account ${RUNTIME_SA}"
exists iam service-accounts describe "${RUNTIME_SA}" ||
  cmd iam service-accounts create "${RUNTIME_SA_NAME}" --display-name="SignuDoc on Cloud Run"
# Connecting to Cloud SQL is the only project-wide role. Everything else is
# granted on the one bucket or secret it is for.
cmd projects add-iam-policy-binding "${PROJECT_ID}" --condition=None \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/cloudsql.client >/dev/null
# Signing as itself, for signed URLs and Google Workspace domain-wide
# delegation (src/lib/integrations/google/credentials.ts).
cmd iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/iam.serviceAccountTokenCreator >/dev/null

step "Cloud SQL for PostgreSQL 17: ${DB_INSTANCE}"
exists sql instances describe "${DB_INSTANCE}" ||
  cmd sql instances create "${DB_INSTANCE}" --region="${REGION}" \
    --database-version=POSTGRES_17 --edition=enterprise --tier="${DB_TIER}" \
    --storage-auto-increase --ssl-mode=ENCRYPTED_ONLY --deletion-protection \
    --backup-start-time=03:00 --retained-backups-count=14 \
    --enable-point-in-time-recovery --retained-transaction-log-days=7
exists sql databases describe "${DB_NAME}" --instance="${DB_INSTANCE}" ||
  cmd sql databases create "${DB_NAME}" --instance="${DB_INSTANCE}"
if ! has_secret_value "$(secret_name database-url)"; then
  DB_PASSWORD="$(openssl rand -hex 24)"
  if exists sql users describe "${DB_USER}" --instance="${DB_INSTANCE}"; then
    printf '  + gcloud sql users set-password %s (password not shown)\n' "${DB_USER}"
    gc sql users set-password "${DB_USER}" --instance="${DB_INSTANCE}" --password="${DB_PASSWORD}"
  else
    printf '  + gcloud sql users create %s (password not shown)\n' "${DB_USER}"
    gc sql users create "${DB_USER}" --instance="${DB_INSTANCE}" --password="${DB_PASSWORD}"
  fi
  # Through the Cloud SQL connector's Unix socket that Cloud Run mounts.
  put_secret "$(secret_name database-url)" \
    "postgres://${DB_USER}:${DB_PASSWORD}@localhost/${DB_NAME}?host=/cloudsql/${SQL_CONNECTION}"
else
  put_secret "$(secret_name database-url)"
fi

step "Private bucket gs://${BUCKET}"
exists storage buckets describe "gs://${BUCKET}" ||
  cmd storage buckets create "gs://${BUCKET}" --location="${REGION}" \
    --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=7d
cmd storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin >/dev/null

if [[ -n "${BACKUP_REGION:-}" ]]; then
  step "Backup bucket gs://${BACKUP_BUCKET} in ${BACKUP_REGION}"
  exists storage buckets describe "gs://${BACKUP_BUCKET}" ||
    cmd storage buckets create "gs://${BACKUP_BUCKET}" --location="${BACKUP_REGION}" \
      --uniform-bucket-level-access --public-access-prevention --soft-delete-duration=7d
  cmd storage buckets update "gs://${BACKUP_BUCKET}" --versioning >/dev/null
  cmd storage buckets add-iam-policy-binding "gs://${BACKUP_BUCKET}" \
    --member="serviceAccount:${RUNTIME_SA}" --role=roles/storage.objectAdmin >/dev/null
fi

step "Secrets"
put_generated_secret "$(secret_name better-auth-secret)"
put_generated_secret "$(secret_name setup-token)"
put_generated_secret "$(secret_name retention-job-secret)"
SECRETS="DATABASE_URL=$(secret_name database-url):latest"
SECRETS+=",BETTER_AUTH_SECRET=$(secret_name better-auth-secret):latest"
SECRETS+=",SETUP_TOKEN=$(secret_name setup-token):latest"
SECRETS+=",RETENTION_JOB_SECRET=$(secret_name retention-job-secret):latest"
for optional in RESEND_API_KEY SSO_CLIENT_SECRET; do
  name="$(secret_name "$(tr 'A-Z_' 'a-z-' <<<"${optional}")")"
  if [[ -n "${!optional:-}" ]] || exists secrets describe "${name}"; then
    put_secret "${name}" "${!optional:-}"
    if has_secret_value "${name}"; then
      SECRETS+=",${optional}=${name}:latest"
    fi
  fi
done

ENV_VARS="APP_URL=${APP_URL},STORAGE_DRIVER=gcs,GCS_BUCKET=${BUCKET}"
[[ -n "${BACKUP_REGION:-}" ]] && ENV_VARS+=",BACKUP_GCS_BUCKET=${BACKUP_BUCKET}"
[[ -n "${EXTRA_ENV_VARS:-}" ]] && ENV_VARS+=",${EXTRA_ENV_VARS}"

if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
  step "Workload Identity Federation for ${GITHUB_REPOSITORY}"
  POOL="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/github"
  exists iam workload-identity-pools describe github --location=global ||
    cmd iam workload-identity-pools create github --location=global --display-name="GitHub Actions"
  exists iam workload-identity-pools providers describe github --location=global --workload-identity-pool=github ||
    cmd iam workload-identity-pools providers create-oidc github --location=global \
      --workload-identity-pool=github --issuer-uri="https://token.actions.githubusercontent.com" \
      --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
      --attribute-condition="assertion.repository == '${GITHUB_REPOSITORY}'"
  exists iam service-accounts describe "${DEPLOY_SA}" ||
    cmd iam service-accounts create "${SERVICE}-deploy" --display-name="SignuDoc deploys from GitHub"
  cmd iam service-accounts add-iam-policy-binding "${DEPLOY_SA}" --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/${POOL}/attribute.repository/${GITHUB_REPOSITORY}" >/dev/null
  cmd projects add-iam-policy-binding "${PROJECT_ID}" --condition=None \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/run.developer >/dev/null
  cmd iam service-accounts add-iam-policy-binding "${RUNTIME_SA}" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/iam.serviceAccountUser >/dev/null
  cmd artifacts repositories add-iam-policy-binding "${REPOSITORY}" --location="${REGION}" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/artifactregistry.writer >/dev/null
fi

if [[ -z "${IMAGE:-}" && "${USE_LOCAL_DOCKER:-}" != "1" ]]; then
  step "Letting Cloud Build push to ${REPOSITORY}"
  BUILD_SA="$(gc builds get-default-service-account --format='value(serviceAccountEmail)')"
  BUILD_SA="${BUILD_SA##*/}"
  cmd artifacts repositories add-iam-policy-binding "${REPOSITORY}" --location="${REGION}" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/artifactregistry.writer >/dev/null
  cmd projects add-iam-policy-binding "${PROJECT_ID}" --condition=None \
    --member="serviceAccount:${BUILD_SA}" --role=roles/logging.logWriter >/dev/null
  exists storage buckets describe "gs://${PROJECT_ID}_cloudbuild" ||
    cmd storage buckets create "gs://${PROJECT_ID}_cloudbuild" --location=US --uniform-bucket-level-access
  cmd storage buckets add-iam-policy-binding "gs://${PROJECT_ID}_cloudbuild" \
    --member="serviceAccount:${BUILD_SA}" --role=roles/storage.objectViewer >/dev/null
fi

if [[ -z "${IMAGE:-}" ]]; then
  IMAGE="$(build_and_push_image)"
fi

step "Migrate job ${MIGRATE_JOB}"
cmd run jobs deploy "${MIGRATE_JOB}" --region="${REGION}" --image="${IMAGE}" \
  --service-account="${RUNTIME_SA}" --set-cloudsql-instances="${SQL_CONNECTION}" \
  --update-secrets="DATABASE_URL=$(secret_name database-url):latest" \
  --command=node --args=db/migrate.mjs --max-retries=0 --task-timeout=600s
run_migrations "${IMAGE}"

step "Cloud Run service ${SERVICE}"
cmd run deploy "${SERVICE}" --region="${REGION}" --image="${IMAGE}" \
  --service-account="${RUNTIME_SA}" --add-cloudsql-instances="${SQL_CONNECTION}" \
  --allow-unauthenticated --port=8080 --cpu=1 --memory=1Gi --concurrency=40 \
  --min-instances="${MIN_INSTANCES:-0}" --max-instances="${MAX_INSTANCES:-4}" --timeout=300s --cpu-boost \
  --execution-environment=gen2 \
  --update-env-vars="${ENV_VARS}" --update-secrets="${SECRETS}" \
  --startup-probe="httpGet.path=/api/health,periodSeconds=3,failureThreshold=40,timeoutSeconds=3" \
  --liveness-probe="httpGet.path=/api/health,periodSeconds=30,failureThreshold=3,timeoutSeconds=5"
SERVICE_URL="$(gc run services describe "${SERVICE}" --region="${REGION}" --format='value(status.url)')"

step "Daily jobs in Cloud Scheduler"
JOB_SECRET="$(gc secrets versions access latest --secret="$(secret_name retention-job-secret)")"
schedule() {
  local name="$1" path="$2" when="$3" verb=create
  exists scheduler jobs describe "${name}" --location="${REGION}" && verb=update
  printf '  + gcloud scheduler jobs %s http %s (%s %s, bearer secret not shown)\n' "${verb}" "${name}" "${when}" "${path}"
  local headers_flag="--headers"
  [[ "${verb}" == update ]] && headers_flag="--update-headers"
  gc scheduler jobs "${verb}" http "${name}" --location="${REGION}" --schedule="${when}" \
    --time-zone=UTC --uri="${SERVICE_URL}${path}" --http-method=POST --attempt-deadline=600s \
    "${headers_flag}=Authorization=Bearer ${JOB_SECRET}" >/dev/null
}
schedule "${SERVICE}-retention" /api/internal/retention "0 9 * * *"
[[ -n "${BACKUP_REGION:-}" ]] && schedule "${SERVICE}-backup" /api/internal/backup "0 8 * * *"

if [[ -n "${DOMAIN:-}" ]]; then
  step "Domain mapping for ${DOMAIN}"
  exists beta run domain-mappings describe --domain="${DOMAIN}" --region="${REGION}" ||
    cmd beta run domain-mappings create --service="${SERVICE}" --domain="${DOMAIN}" --region="${REGION}"
  echo "  Add this DNS record at your DNS host (DNS only, not proxied):"
  gc beta run domain-mappings describe --domain="${DOMAIN}" --region="${REGION}" \
    --format='table[box](status.resourceRecords.name,status.resourceRecords.type,status.resourceRecords.rrdata)'
fi

step "Done"
cat <<EOF
  Site:       ${APP_URL}
  Service:    ${SERVICE_URL}
  Image:      ${IMAGE}

  Open ${APP_URL}/setup and follow the onboarding. It asks for the setup
  token, which you can read with:
    gcloud secrets versions access latest --secret=$(secret_name setup-token) --project=${PROJECT_ID}
EOF
