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

while true; do
  set +e
  node app.js
  code=$?
  set -e
  if [ "$code" -eq 0 ]; then
    exit 0
  fi
  if [ "$code" -eq 42 ]; then
    echo "[BOOT] Restart requested from dashboard. Relaunching..."
    sleep 2
    continue
  fi
  exit "$code"
done
