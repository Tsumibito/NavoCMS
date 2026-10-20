#!/bin/sh
set -eu
: "${DOTENV_PRIVATE_KEY:?runtime decryption key required}"
: "${DOTENV_OPS_PRIVATE_KEY:?operations decryption key required}"
compose() { docker compose -f deploy/self-host/compose.yml --profile operations "$@"; }
activated=false
cleanup() { if [ "$activated" = true ]; then compose stop cms; fi; }
trap cleanup EXIT
compose run --rm operations node dist/operations-cli.js install /run/navocms/site.json
compose run --rm operations node dist/operations-cli.js doctor
activated=true
compose up -d --wait --wait-timeout 90 cms
compose exec -T cms node -e "fetch('http://127.0.0.1:8788/readyz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
activated=false
