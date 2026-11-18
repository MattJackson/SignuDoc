# syntax=docker/dockerfile:1
#
# SignuDoc as one container, for Google Cloud Run or any other host that
# runs Docker images. See docs/google-cloud-run.md.
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
# For `node db/migrate.mjs`, run as a Cloud Run job from this same image.
COPY --from=builder /app/db/migrate.mjs /app/db/database-url.mjs ./db/
COPY --from=builder /app/db/migrations ./db/migrations

RUN mkdir -p /data .next/cache \
  && chown node:node /data .next/cache

USER node
EXPOSE 8080
CMD ["node", "server.js"]
