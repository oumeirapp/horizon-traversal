#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "Python/Rust parity currently requires Apple Silicon macOS." >&2
  exit 1
fi

for asset in \
  "$REPOSITORY/src-tauri/binaries/ffmpeg-aarch64-apple-darwin" \
  "$REPOSITORY/src-tauri/binaries/ffprobe-aarch64-apple-darwin" \
  "$REPOSITORY/src-tauri/resources/native/libpdfium.dylib"
do
  if [ ! -f "$asset" ]; then
    echo "Missing native parity asset: $asset" >&2
    exit 1
  fi
done

(cd "$REPOSITORY" && npm run verify:native)

X_TRAVERSAL_RUN_PYTHON_PARITY=1 \
  cargo test \
    --locked \
    --manifest-path "$REPOSITORY/src-tauri/Cargo.toml" \
    --test python_parity \
    -- --ignored --nocapture
