#!/bin/sh
set -eu
exec docker compose -f "${NAVOCMS_COMPOSE_FILE:-deploy/self-host/compose.yml}" --profile operations run --rm operations node dist/operations-cli.js monitor /backups/latest.navo
