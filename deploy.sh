#!/usr/bin/env bash
#
# Deploy the currently-pushed main onto this box. Run it ON the VPS:
#   /srv/stickstakes/deploy.sh
# or from a dev machine via `npm run deploy`.
set -euo pipefail

cd /srv/stickstakes

git pull --ff-only

# --include=dev is deliberate: the build needs typescript and vite, which are
# devDependencies. Plain `npm ci` skips them whenever NODE_ENV=production is set
# in the environment, and the build then fails with a confusing "tsc: not found".
npm ci --include=dev

npm run build

pm2 reload stickstakes --update-env

# Non-streaming, so the script actually exits.
echo
echo "--- last 20 log lines ---"
pm2 logs stickstakes --lines 20 --nostream
