# syntax=docker/dockerfile:1
#
# SignuDoc as one generic container image for any host that runs Docker:
# docker run, Compose, Cloud Run, Kubernetes. Everything is configured with
# environment variables and in the app. Examples: examples/docker-compose/
# and examples/google-cloud-run/.
#
#   docker build -t signudoc .
#   docker run -p 8080:8080 --env-file .env signudoc               the app
#   docker run --env-file .env signudoc node db/migrate.mjs        migrations
#
# The same image serves the app and runs the migrations, so a deploy can run
# the migrate job with exactly the code it is about to serve.

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:${NODE_VERSION}-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Turns on Next.js standalone output (next.config.ts).
ENV NEXT_OUTPUT=standalone
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build \
  && node scripts/copy-migrate-packages.mjs .next/standalone

# Litestream, which replicates a SQLite database to Cloud Storage
# (docs/design/database-backends.md). A pinned release, checked against
# its published SHA-256 before it is used.
FROM node:${NODE_VERSION}-bookworm-slim AS litestream
ARG TARGETARCH
ARG LITESTREAM_VERSION=0.5.18
ARG LITESTREAM_SHA256_AMD64=d3687b9fd0f2e9426bbd3da828429ff3f1dfc5c9b74d54fdf028e4ee510e7dea
ARG LITESTREAM_SHA256_ARM64=922a09e6a7ac67f2095571894dc6382e94e1dd4cdd9674883ddf1a8e74ab982d
RUN set -eu; \
  case "${TARGETARCH:-amd64}" in \
    amd64) arch=x86_64; sum="${LITESTREAM_SHA256_AMD64}" ;; \
    arm64) arch=arm64; sum="${LITESTREAM_SHA256_ARM64}" ;; \
    *) echo "No Litestream build for ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  url="https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-${LITESTREAM_VERSION}-linux-${arch}.tar.gz"; \
  node -e 'fetch(process.argv[1]).then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); require("node:fs").writeFileSync("/tmp/litestream.tar.gz", Buffer.from(await r.arrayBuffer())); })' "${url}"; \
  echo "${sum}  /tmp/litestream.tar.gz" | sha256sum -c -; \
  tar -xzf /tmp/litestream.tar.gz -C /usr/local/bin litestream; \
  /usr/local/bin/litestream version

FROM node:${NODE_VERSION}-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
  NEXT_TELEMETRY_DISABLED=1 \
  PORT=8080 \
  HOSTNAME=0.0.0.0 \
  STORAGE_LOCAL_DIR=/data/storage \
  EMAIL_CAPTURE_DIR=/data/outbox

# The app's files belong to root and cannot be changed by the server. Only
# /data (local file storage, when that driver is used) and Next.js's cache
# are writable by the user the server runs as.
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Read from disk at runtime when a finished PDF is drawn
# (src/lib/services/pdf-fonts.ts). Next.js traces them for the API routes
# already (outputFileTracingIncludes); copying them makes sure every route
# has them.
COPY --from=builder /app/src/assets/fonts ./src/assets/fonts
COPY --from=builder /app/node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm ./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm
# For `node db/migrate.mjs`, run as a separate job from this same image.
COPY --from=builder /app/db/migrate.mjs /app/db/database-url.mjs ./db/
COPY --from=builder /app/db/migrations ./db/migrations
# The SQLite backend: its schema, migrations and start script.
COPY --from=builder /app/db/sqlite ./db/sqlite
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream

RUN mkdir -p /data .next/cache \
  && chown node:node /data .next/cache

USER node
EXPOSE 8080
# `node server.js` for Postgres; for a sqlite: DATABASE_URL,
# migrations at start and Litestream when LITESTREAM_REPLICA_URL is set.
CMD ["sh", "db/sqlite/entrypoint.sh"]
