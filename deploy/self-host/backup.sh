#!/bin/sh
set -eu
umask 077
directory="${NAVOCMS_BACKUP_DIRECTORY:?private backup directory required}"
file="backup-$(date -u +%Y%m%dT%H%M%SZ).navo"
docker compose -f "${NAVOCMS_COMPOSE_FILE:-deploy/self-host/compose.yml}" --profile operations run --rm operations node dist/operations-cli.js backup "/backups/$file"
# Preserve successful generations. Retention and off-host copies are operator-owned.
ln -s "$file" "$directory/latest.navo.new"
mv -Tf "$directory/latest.navo.new" "$directory/latest.navo"
