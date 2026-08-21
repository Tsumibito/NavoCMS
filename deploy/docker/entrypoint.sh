#!/bin/sh
set -eu

if [ -n "${NAVOCMS_ENV_FILE:-}" ]; then
  if [ ! -r "${NAVOCMS_ENV_FILE}" ]; then
    echo "Configured NavoCMS environment file is not readable." >&2
    exit 1
  fi
  exec dotenvx run -f "${NAVOCMS_ENV_FILE}" -- "$@"
fi

exec "$@"
