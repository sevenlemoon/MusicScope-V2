#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ "${1:-}" == "--legacy-docker" ]]; then
  shift
  exec "$ROOT_DIR/scripts/dev.sh" "$@"
fi
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  printf 'MusicScope 当前 macOS 音频依赖支持 Apple silicon；此启动器需要 arm64 macOS。\n' >&2
  exit 1
fi
# Finder does not source the interactive shell's nvm configuration.
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 && Number(process.versions.node.split(".")[1]) >= 21 ? 0 : 1)' 2>/dev/null; then
  if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    set +u
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" --no-use
    nvm use --silent "$(cat "$ROOT_DIR/.node-version")" || true
    set -u
  fi
fi
if ! command -v node >/dev/null 2>&1; then
  printf '缺少 Node.js。请先安装仓库 .node-version 指定的 Node 24，再次双击即可。\n' >&2
  exit 1
fi
exec node "$ROOT_DIR/scripts/mac_launcher.cjs" "$@"
