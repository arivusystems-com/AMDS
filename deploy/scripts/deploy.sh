#!/usr/bin/env bash
# Post-provision deploy helper for OCI compute (bare metal or VM).
# Run on the AMDS host after cloning the repo and configuring .env.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

echo "==> AMDS deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [[ ! -f .env ]]; then
  echo "Missing .env — copy .env.example and configure production values."
  exit 1
fi

echo "==> Install dependencies"
npm ci

echo "==> Build"
npm run build

echo "==> Migrate database"
npm run db:migrate

if command -v systemctl >/dev/null 2>&1; then
  echo "==> Restart systemd units (if installed)"
  sudo systemctl daemon-reload || true
  sudo systemctl restart amds-gateway || true
  sudo systemctl restart 'amds-worker@*' || true
fi

echo "==> Health check"
sleep 2
curl -sf "http://127.0.0.1:${AMDS_PORT:-8080}/ready" | head -c 200
echo ""
echo "Deploy complete."
