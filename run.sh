#!/bin/bash
set -e

cd "$(dirname "$0")"

if node scripts/check-deps.js --quiet; then
  dep_status=0
else
  dep_status=$?
fi

if [ "$dep_status" -ne 0 ]; then
  if [ "$dep_status" -ge 2 ]; then
    echo "[VALIDATION] dependency check failed. Startup canceled."
    exit 1
  fi

  echo "[VALIDATION] installing missing dependencies..."
  if ! npm install; then
    echo "[VALIDATION] dependency install failed. Startup canceled."
    exit 1
  fi
  echo "[VALIDATION] dependencies installed."
fi

node app.js
