# shellcheck shell=bash disable=SC2034
# Settings and helpers shared by setup.sh and deploy.sh. Sourced, not run,
# so some of the settings are only used by the script that sources it.
#
# Every setting is an environment variable. Only PROJECT_ID is required.

: "${PROJECT_ID:?Set PROJECT_ID to your Google Cloud project ID, e.g. PROJECT_ID=my-project}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-signudoc}"
REPOSITORY="${REPOSITORY:-signudoc}"
MIGRATE_JOB="${MIGRATE_JOB:-${SERVICE}-migrate}"
RUNTIME_SA_NAME="${RUNTIME_SA_NAME:-${SERVICE}-run}"
RUNTIME_SA="${RUNTIME_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
REGISTRY="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}"
IMAGE_NAME="${REGISTRY}/${SERVICE}"

gc() {
  gcloud --project="${PROJECT_ID}" --quiet "$@"
}

step() {
  printf '\n==> %s\n' "$*"
}

# Prints a command, then runs it. Not for commands with a secret in them.
cmd() {
  printf '  + %s\n' "$*"
  gc "$@"
}

exists() {
  gc "$@" >/dev/null 2>&1
}

# Builds the image from the repository root and pushes it to Artifact
# Registry, then prints the image by digest (repo/name@sha256:...), which
# is what gets deployed so a later push to the same tag changes nothing.
#
# Cloud Build does the build unless USE_LOCAL_DOCKER=1, in which case the
# Docker on this machine does (for linux/amd64, what Cloud Run runs).
build_and_push_image() {
  local root tag
  root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  tag="${IMAGE_TAG:-$(git -C "${root}" rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"

  step "Building ${IMAGE_NAME}:${tag}" >&2

  # Each step says "|| return 1": this runs inside $(...), where bash does
  # not stop on a failed command by itself.
  if [[ "${USE_LOCAL_DOCKER:-}" == "1" ]]; then
    gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >&2 || return 1
    docker build --platform linux/amd64 -t "${IMAGE_NAME}:${tag}" "${root}" >&2 || return 1
    docker push "${IMAGE_NAME}:${tag}" >&2 || return 1
  else
    gc builds submit "${root}" --region="${REGION}" --tag="${IMAGE_NAME}:${tag}" >&2 || return 1
  fi

  local digest
  digest="$(gc artifacts docker images describe "${IMAGE_NAME}:${tag}" \
    --format='value(image_summary.digest)')" || return 1
  [[ -n "${digest}" ]] || return 1
  printf '%s@%s\n' "${IMAGE_NAME}" "${digest}"
}

# Runs the migrate job with the given image and waits for it to finish.
run_migrations() {
  local image="$1"

  step "Applying database migrations with ${image}"
  cmd run jobs update "${MIGRATE_JOB}" --region="${REGION}" --image="${image}"
  cmd run jobs execute "${MIGRATE_JOB}" --region="${REGION}" --wait
}
