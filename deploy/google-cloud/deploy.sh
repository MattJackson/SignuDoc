#!/usr/bin/env bash
# Deploys a new version of SignuDoc to a Cloud Run setup made by setup.sh:
# builds and pushes the image, runs the migrations with it (Postgres; on
# SQLite the container runs them itself when it starts), then points the
# service at it by digest. Every other setting of the service is kept.
#
#   PROJECT_ID=my-project REGION=us-central1 ./deploy/google-cloud/deploy.sh
#
# IMAGE=<repo/name@sha256:...> deploys an image that already exists instead
# of building one. USE_LOCAL_DOCKER=1 builds with this machine's Docker
# rather than Cloud Build. SERVICE, REPOSITORY and MIGRATE_JOB must match
# what setup.sh used. DB_BACKEND=sqlite|postgres says which database the
# service uses; by default it is worked out from whether the Postgres
# migrate job exists.
set -euo pipefail

# shellcheck source=deploy/google-cloud/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ -z "${DB_BACKEND:-}" ]]; then
  # A failed lookup stops the script (set -e) instead of reading as "no job".
  migrate_job="$(gc run jobs list --region="${REGION}" \
    --filter="metadata.name=${MIGRATE_JOB}" --format='value(metadata.name)')"
  if [[ -n "${migrate_job}" ]]; then
    DB_BACKEND=postgres
  else
    DB_BACKEND=sqlite
  fi
fi

if [[ -z "${IMAGE:-}" ]]; then
  IMAGE="$(build_and_push_image)"
fi

if [[ "${DB_BACKEND}" == postgres ]]; then
  run_migrations "${IMAGE}"
fi

step "Deploying ${IMAGE} to ${SERVICE} (${DB_BACKEND})"
cmd run services update "${SERVICE}" --region="${REGION}" --image="${IMAGE}"

step "Done"
gc run services describe "${SERVICE}" --region="${REGION}" \
  --format='value(status.url,status.latestReadyRevisionName)'
