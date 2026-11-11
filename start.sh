#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules/ws ]; then
  npm install
fi
exec node server.mjs "$@"
