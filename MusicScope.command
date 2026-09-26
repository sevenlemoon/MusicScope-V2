#!/usr/bin/env bash

set -u

LAUNCHER_PATH="${BASH_SOURCE[0]}"
symlink_hops=0
while [[ -L "$LAUNCHER_PATH" ]]; do
  ((symlink_hops += 1))
  if ((symlink_hops > 16)); then
    printf 'MusicScope launcher: too many symlink hops.\n' >&2
    exit 1
  fi
  launcher_dir="$(cd "$(dirname "$LAUNCHER_PATH")" && pwd -P)" || exit 1
  link_target="$(readlink "$LAUNCHER_PATH")" || exit 1
  if [[ "$link_target" == /* ]]; then
    LAUNCHER_PATH="$link_target"
  else
    LAUNCHER_PATH="$launcher_dir/$link_target"
  fi
done

REPO_DIR="$(cd "$(dirname "$LAUNCHER_PATH")" && pwd -P)" || exit 1
cd "$REPO_DIR" || exit 1

./scripts/dev.sh "$@"
status=$?

if ((status != 0 && status != 130 && status != 143)) && [[ -t 0 ]]; then
  printf '\nMusicScope could not start. The terminal is being kept open so you can read the message above.\n'
  read -r -p 'Press Return to close this window. ' _ || true
fi

exit "$status"
