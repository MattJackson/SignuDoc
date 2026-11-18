#!/usr/bin/env bash
# Deploys a new version of SignuDoc to a Cloud Run setup made by setup.sh:
# builds and pushes the image, runs the migrations with it, then points the
# service at it by digest. Every other setting of the service is kept.
#
#   PROJECT_ID=my-project REGION=us-central1 ./deploy/google-cloud/deploy.sh
#
# IMAGE=<repo/name@sha256:...> deploys an image that already exists instead
# of building one. USE_LOCAL_DOCKER=1 builds with this machine's Docker
# rather than Cloud Build. SERVICE, REPOSITORY and MIGRATE_JOB must match
# what setup.sh used.
set -euo pipefail

# shellcheck source=deploy/google-cloud/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

if [[ -z "${IMAGE:-}" ]]; then
  IMAGE="$(build_and_push_image)"
fi

run_migrations "${IMAGE}"

step "Deploying ${IMAGE} to ${SERVICE}"
cmd run services update "${SERVICE}" --region="${REGION}" --image="${IMAGE}"

step "Done"
gc run services describe "${SERVICE}" --region="${REGION}" \
  --format='value(status.url,status.latestReadyRevisionName)'
