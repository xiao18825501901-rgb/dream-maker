#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
node scripts/doctor.mjs --runtime-only
exec node dist/server/main.js
