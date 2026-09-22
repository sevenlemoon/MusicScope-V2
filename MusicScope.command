#!/usr/bin/env bash

set -u

REPO_DIR="$(cd "$(dirname "$0")" && pwd -P)" || exit 1
cd "$REPO_DIR" || exit 1

./scripts/dev.sh "$@"
status=$?

if ((status != 0 && status != 130 && status != 143)) && [[ -t 0 ]]; then
  printf '\nMusicScope could not start. The terminal is being kept open so you can read the message above.\n'
  read -r -p 'Press Return to close this window. ' _ || true
fi

exit "$status"
