#!/usr/bin/env bash
# iMux fork dev loop: tagged Debug rebuild + relaunch.
#
# Wraps scripts/reload.sh with two host workarounds:
#   1. CMUX_SKIP_ZIG_BUILD=1 — zig 0.15.2 cannot link against the Xcode 26.4+
#      SDK (libSystem.tbd lost its arm64-macos slice; ziglang issue #31658),
#      so the Ghostty CLI helper build phase writes a Mach-O stub instead.
#   2. Swap the stub for a real helper binary borrowed from an installed
#      iMux.app / cmux.app (same Ghostty version, zig 0.15.2 ReleaseFast).
#
# Usage: ./scripts/dev.sh [--tag <name>] [reload.sh args...]
#        Default tag: dev. Always launches the app after build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG="dev"
ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:?--tag requires a value}"; shift 2 ;;
    *) ARGS+=("$1"); shift ;;
  esac
done

HELPER_SRC=""
for candidate in \
  "/Applications/iMux.app/Contents/Resources/bin/ghostty" \
  "/Applications/cmux.app/Contents/Resources/bin/ghostty"; do
  if [[ -x "$candidate" ]]; then
    HELPER_SRC="$candidate"
    break
  fi
done

CMUX_SKIP_ZIG_BUILD=1 "$REPO_ROOT/scripts/reload.sh" --tag "$TAG" ${ARGS[@]+"${ARGS[@]}"}

APP_PATH="$HOME/Library/Developer/Xcode/DerivedData/cmux-${TAG}/Build/Products/Debug/iMux DEV ${TAG}.app"
if [[ ! -d "$APP_PATH" ]]; then
  echo "error: built app not found: $APP_PATH" >&2
  exit 1
fi

if [[ -n "$HELPER_SRC" ]]; then
  cp "$HELPER_SRC" "$APP_PATH/Contents/Resources/bin/ghostty"
  codesign --force --sign - "$APP_PATH/Contents/Resources/bin/ghostty" >/dev/null 2>&1
  echo "==> Ghostty helper swapped in from $HELPER_SRC"
else
  echo "warning: no installed iMux/cmux app found; Ghostty helper is a stub" >&2
fi

open "$APP_PATH"
echo "==> launched: $APP_PATH"
