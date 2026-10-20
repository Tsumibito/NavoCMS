#!/bin/sh
set -eu
umask 077
file="backup-$(date -u +%Y%m%dT%H%M%SZ).navo"
docker compose -f deploy/self-host/compose.yml --profile operations run --rm operations node dist/operations-cli.js backup "/backups/$file"
# Preserve successful generations. Retention and off-host copies are operator-owned.
ln -s "$file" /var/backups/navocms/latest.navo.new
mv -Tf /var/backups/navocms/latest.navo.new /var/backups/navocms/latest.navo
