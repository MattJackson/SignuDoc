#!/bin/sh
# The Docker image's start command. A sqlite: DATABASE_URL starts through
# db/sqlite/start.mjs (migrations, and Litestream when
# LITESTREAM_REPLICA_URL is set); anything else starts the server exactly
# as before. See docs/design/database-backends.md.
set -e

case "${DATABASE_URL:-}" in
  sqlite:* | SQLITE:*) exec node db/sqlite/start.mjs ;;
  *) exec node server.js ;;
esac
