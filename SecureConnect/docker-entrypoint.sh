#!/bin/sh
# Entrypoint: load runtime env then start the Next.js standalone server.
#
# Why this exists: .env.production is provided at runtime (bind-mounted, not baked
# into the image). Windows editors frequently save it with a leading UTF-8 BOM
# (EF BB BF). A BOM makes `. env` name the FIRST variable "<BOM>AUTH_GOOGLE_ID"
# instead of "AUTH_GOOGLE_ID", so NextAuth silently loses its Google client id and
# every login fails with a Configuration/Callback error. We strip a leading BOM
# defensively so the app is robust to how the env file was authored.
set -e

ENV_FILE="${ENV_FILE:-/app/.env.production}"

if [ -f "$ENV_FILE" ]; then
  # Strip a leading UTF-8 BOM from line 1 (busybox sed: feed the raw BOM bytes
  # into the pattern via printf octal, since it doesn't grok \xNN escapes).
  sed "$(printf '1s/^\357\273\277//')" "$ENV_FILE" > /tmp/.env.runtime
  set -a
  # shellcheck disable=SC1091
  . /tmp/.env.runtime
  set +a
  rm -f /tmp/.env.runtime
fi

exec node server.js
