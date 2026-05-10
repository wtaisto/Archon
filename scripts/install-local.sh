#!/usr/bin/env bash
# scripts/install-local.sh
# Build the current git checkout into a binary and install it on this machine.
#
# Defaults:
#   - Builds for the host platform only (single target).
#   - Installs to $HOME/.local/bin/archon (no sudo).
#   - Builds whatever HEAD currently points at — does NOT switch branches or pull.
#
# To install the current state of main:
#   git checkout main && git pull && bun run install:local
#
# To install your current dev branch state (fast iteration):
#   bun run install:local
#
# Overrides:
#   INSTALL_DIR=/usr/local/bin bash scripts/install-local.sh   # may need sudo
#   BINARY_NAME=archon-dev    bash scripts/install-local.sh   # install side-by-side

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
BINARY_NAME="${BINARY_NAME:-archon}"

# Detect host platform → Bun target triple (matches build-binaries.sh names).
detect_target() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"

  case "$os" in
    darwin) os="darwin" ;;
    linux)  os="linux" ;;
    *) echo "ERROR: unsupported OS: $os" >&2; exit 1 ;;
  esac

  case "$arch" in
    x86_64|amd64)  arch="x64" ;;
    arm64|aarch64) arch="arm64" ;;
    *) echo "ERROR: unsupported arch: $arch" >&2; exit 1 ;;
  esac

  echo "bun-${os}-${arch}"
}

TARGET="$(detect_target)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'detached')"
COMMIT="$(git rev-parse --short HEAD)"
DIRTY=""
if ! git diff --quiet --ignore-submodules HEAD 2>/dev/null; then
  DIRTY=" (uncommitted changes)"
fi

echo "Installing Archon from current checkout"
echo "  branch:      ${BRANCH}${DIRTY}"
echo "  commit:      ${COMMIT}"
echo "  target:      ${TARGET}"
echo "  install to:  ${INSTALL_DIR}/${BINARY_NAME}"
echo ""

echo "Installing dependencies..."
bun install

TMP_DIR="$(mktemp -d)"
trap "rm -rf '$TMP_DIR'" EXIT
TMP_BINARY="$TMP_DIR/${BINARY_NAME}"

echo ""
echo "Building binary..."
TARGET="$TARGET" OUTFILE="$TMP_BINARY" bash scripts/build-binaries.sh

mkdir -p "$INSTALL_DIR"
mv "$TMP_BINARY" "$INSTALL_DIR/$BINARY_NAME"
chmod +x "$INSTALL_DIR/$BINARY_NAME"

echo ""
echo "Installed: $INSTALL_DIR/$BINARY_NAME"
"$INSTALL_DIR/$BINARY_NAME" version || echo "(version check failed — binary may still work; try '$BINARY_NAME version' manually)"

RESOLVED="$(command -v "$BINARY_NAME" 2>/dev/null || true)"
if [ -z "$RESOLVED" ]; then
  echo ""
  echo "WARNING: $INSTALL_DIR is not on your PATH."
  echo "  Add it with: export PATH=\"$INSTALL_DIR:\$PATH\""
elif [ "$RESOLVED" != "$INSTALL_DIR/$BINARY_NAME" ]; then
  echo ""
  echo "WARNING: '$BINARY_NAME' on PATH resolves to $RESOLVED, not the freshly installed copy."
  echo "  Reorder PATH so $INSTALL_DIR comes first, or remove the older binary."
fi
