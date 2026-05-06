#!/bin/sh
# Vibe Transactions Converter — runs before the API server starts.
#
# The SPA in apps/web is built with `base: '/__VIBE_BASE_PATH__/'` so a
# single image can serve either '/' (single-app standalone) or
# '/<prefix>/' (multi-app behind the Vibe-Appliance shared Caddy with
# path-prefix routing in LAN / Tailscale modes). This script substitutes
# the placeholder in /app/apps/web/dist before exec'ing the API CMD,
# which serves those static files via Express.
#
# VITE_BASE_PATH defaults to '/'. A bare prefix without a trailing slash
# is normalized so React Router and asset URLs both stay consistent.
# Same shape as sibling apps' entrypoints (see
# Vibe-Trial-Balance/deploy/web-entrypoint.sh) — kept in lockstep so the
# Vibe-Appliance contract (env var name + sentinel value) is uniform
# across the family.

set -eu

raw="${VITE_BASE_PATH:-/}"

# Reject anything outside [A-Za-z0-9_./-]. The value lands inside
# `sed s|...|...|` at runtime; characters like `&`, `\`, `|`, `$` would
# break the substitution (sed treats `&` in the replacement as the
# matched string, etc.).
case "$raw" in
  *[!A-Za-z0-9_./-]*)
    echo "[web-base-path] ERROR: VITE_BASE_PATH='$raw' contains characters outside [A-Za-z0-9_./-]" >&2
    exit 1
    ;;
esac

case "$raw" in
  /) base='/' ;;
  /*/) base="$raw" ;;
  /*) base="${raw}/" ;;
  *) base="/${raw}/" ;;
esac

echo "[web-base-path] applying VITE_BASE_PATH=$base"

# Replace the build-time sentinel across SPA assets in place. Idempotent:
# a second pass on a restarted container finds no matches.
find /app/apps/web/dist -type f \
  \( -name '*.html' -o -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.map' \) \
  -exec sed -i "s|/__VIBE_BASE_PATH__/|${base}|g" {} +

# Drop a marker so the active value is observable inside the container.
echo "$base" > /app/apps/web/dist/.base-path

# Hand off to whatever was passed as CMD (node apps/api/dist/index.js).
exec "$@"
