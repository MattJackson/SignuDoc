#!/bin/sh
# The Docker image's start command. A sqlite: DATABASE_URL starts through
# db/sqlite/start.mjs (migrations, and Litestream when
# LITESTREAM_REPLICA_URL is set); anything else starts the server exactly
# as before. See docs/design/database-backends.md.
set -e

# The scheme is read as db/sqlite/open.mjs reads it: leading whitespace (including a newline) and case ignored.
url=$(printf '%s' "${DATABASE_URL:-}" | tr '\t\r\n' '   ' | sed 's/^ *//' | tr '[:upper:]' '[:lower:]')

case "$url" in
  sqlite:*) exec node db/sqlite/start.mjs ;;
  *) exec node server.js ;;
esac
