#!/bin/sh

set -eu

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_file() {
  [ -f "$1" ] || fail "required file is missing: $1"
}

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY=$(CDPATH= cd -- "$SCRIPT_DIRECTORY/../.." && pwd)
TARGET="aarch64-apple-darwin"
APP_BUNDLE="$REPOSITORY/src-tauri/target/$TARGET/release/bundle/macos/Horizon Traversal.app"
FFMPEG="$REPOSITORY/src-tauri/binaries/ffmpeg-$TARGET"
FFPROBE="$REPOSITORY/src-tauri/binaries/ffprobe-$TARGET"
PDF_FIXTURE="$REPOSITORY/src-tauri/tests/fixtures/one-page.pdf"
IMAGE_FIXTURE="$REPOSITORY/src-tauri/icons/128x128@2x.png"
RUNNER="$SCRIPT_DIRECTORY/run-packaged-macos-arm64.sh"
INSPECTOR="$REPOSITORY/scripts/inspect-bundle-macos-arm64.sh"

[ "$(uname -s)" = "Darwin" ] || fail "packaged smoke tests require macOS"
[ "$(uname -m)" = "arm64" ] || fail "packaged smoke tests must run natively on Apple Silicon"
for command in codesign npm plutil sips; do
  require_command "$command"
done
for file in "$FFMPEG" "$FFPROBE" "$PDF_FIXTURE" "$IMAGE_FIXTURE" "$RUNNER" "$INSPECTOR"; do
  require_file "$file"
done

SMOKE_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/horizon-traversal-package-smoke.XXXXXX")
SMOKE_DIRECTORY=$(CDPATH= cd -- "$SMOKE_DIRECTORY" && pwd -P)
SMOKE_SUCCEEDED=0
cleanup() {
  if [ "$SMOKE_SUCCEEDED" != "1" ] || [ "${HORIZON_TRAVERSAL_KEEP_SMOKE_WORKSPACE:-0}" = "1" ]; then
    printf 'Kept packaged smoke workspace: %s\n' "$SMOKE_DIRECTORY"
    return
  fi
  case "${SMOKE_DIRECTORY##*/}" in
    horizon-traversal-package-smoke.*)
      rm -rf -- "$SMOKE_DIRECTORY"
      ;;
    *)
      printf 'warning: refused to remove unexpected smoke path: %s\n' "$SMOKE_DIRECTORY" >&2
      ;;
  esac
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

INPUT_DIRECTORY="$SMOKE_DIRECTORY/input"
OUTPUT_DIRECTORY="$SMOKE_DIRECTORY/output"
SOURCE_DIRECTORY="$INPUT_DIRECTORY/P1 Packaged Smoke/Deliverables"
RESULT_PATH="$SMOKE_DIRECTORY/result.json"
REQUEST_PATH="$SMOKE_DIRECTORY/request.json"
mkdir -p "$SOURCE_DIRECTORY"
cp "$PDF_FIXTURE" "$SOURCE_DIRECTORY/brief.pdf"
sips --resampleHeightWidth 1500 2400 "$IMAGE_FIXTURE" \
  --out "$SOURCE_DIRECTORY/visual.png" >/dev/null

"$FFMPEG" \
  -hide_banner -loglevel error -y \
  -f lavfi -i "color=c=0x0c756d:s=1080x1920:r=10" \
  -f lavfi -i "sine=frequency=880:sample_rate=44100" \
  -t 0.2 -shortest \
  -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a pcm_s16le \
  "$SOURCE_DIRECTORY/clip.mp4"

plutil -create xml1 "$REQUEST_PATH"
plutil -insert inputPath -string "$INPUT_DIRECTORY" "$REQUEST_PATH"
plutil -insert outputPath -string "$OUTPUT_DIRECTORY" "$REQUEST_PATH"
plutil -insert ticketFilter -string "P1" "$REQUEST_PATH"
plutil -insert resultPath -string "$RESULT_PATH" "$REQUEST_PATH"
plutil -convert json "$REQUEST_PATH"

cd "$REPOSITORY"
npm run verify:native
npm run tauri -- build \
  --target "$TARGET" \
  --features packaged-smoke \
  --bundles app \
  --ci \
  --no-sign

[ -d "$APP_BUNDLE" ] || fail "Tauri did not produce the expected app bundle: $APP_BUNDLE"
# Verify byte-for-byte native provenance before signing mutates Mach-O files.
HORIZON_TRAVERSAL_SKIP_CODESIGN_VERIFY=1 "$INSPECTOR" "$APP_BUNDLE"
# The package job has no distribution identity. Apply an explicit ad-hoc deep
# signature so the smoke test still exercises macOS nested-code validation.
codesign --force --deep --sign - --timestamp=none "$APP_BUNDLE"
"$RUNNER" "$APP_BUNDLE" "$REQUEST_PATH"

TICKET_OUTPUT="$OUTPUT_DIRECTORY/P1 Packaged Smoke"
REPORT="$TICKET_OUTPUT/report.txt"
require_file "$TICKET_OUTPUT/brief.png"
require_file "$TICKET_OUTPUT/visual.png"
require_file "$TICKET_OUTPUT/clip.mp4"
require_file "$REPORT"
[ ! -e "$TICKET_OUTPUT/brief.pdf" ] || fail "PDF original remains after successful conversion"

OUTCOME=$(plutil -extract outcome raw -o - "$RESULT_PATH")
STATUS=$(plutil -extract summary.status raw -o - "$RESULT_PATH")
COPIED=$(plutil -extract summary.copiedFiles raw -o - "$RESULT_PATH")
ERRORS=$(plutil -extract summary.errors raw -o - "$RESULT_PATH")
[ "$OUTCOME" = "passed" ] || fail "unexpected smoke outcome: $OUTCOME"
[ "$STATUS" = "success" ] || fail "unexpected pipeline status: $STATUS"
[ "$COPIED" = "3" ] || fail "expected three copied assets, received $COPIED"
[ "$ERRORS" = "0" ] || fail "expected zero pipeline errors, received $ERRORS"

for image in "$TICKET_OUTPUT/brief.png" "$TICKET_OUTPUT/visual.png"; do
  width=$(sips -g pixelWidth "$image" | awk '/pixelWidth:/ { print $2 }')
  height=$(sips -g pixelHeight "$image" | awk '/pixelHeight:/ { print $2 }')
  [ -n "$width" ] && [ -n "$height" ] || fail "cannot read image dimensions: $image"
  [ "$width" -le 1920 ] && [ "$height" -le 1080 ] ||
    fail "image exceeds 1920x1080 after processing: $image (${width}x${height})"
done

VIDEO_STREAM=$("$FFPROBE" \
  -v error -select_streams v:0 \
  -show_entries stream=codec_name,width,height,pix_fmt -of csv=p=0 \
  "$TICKET_OUTPUT/clip.mp4")
[ "$VIDEO_STREAM" = "h264,720,1280,yuv420p" ] ||
  fail "expected H.264 720x1280 yuv420p video, received $VIDEO_STREAM"
AUDIO_STREAM=$("$FFPROBE" \
  -v error -select_streams a:0 \
  -show_entries stream=codec_name -of csv=p=0 \
  "$TICKET_OUTPUT/clip.mp4")
[ "$AUDIO_STREAM" = "aac" ] ||
  fail "expected AAC output from the PCM input, received $AUDIO_STREAM"

for source in \
  "$SOURCE_DIRECTORY/brief.pdf" \
  "$SOURCE_DIRECTORY/clip.mp4" \
  "$SOURCE_DIRECTORY/visual.png"
do
  grep -F -x "$source" "$REPORT" >/dev/null ||
    fail "ticket report is missing source path: $source"
done
[ "$(wc -l < "$REPORT" | tr -d ' ')" = "3" ] ||
  fail "ticket report contains paths outside the current ticket"

if [ -n "${HORIZON_TRAVERSAL_SMOKE_REPORT_PATH:-}" ]; then
  case "$HORIZON_TRAVERSAL_SMOKE_REPORT_PATH" in
    /*)
      ;;
    *)
      fail "HORIZON_TRAVERSAL_SMOKE_REPORT_PATH must be absolute"
      ;;
  esac
  mkdir -p "${HORIZON_TRAVERSAL_SMOKE_REPORT_PATH%/*}"
  cp "$RESULT_PATH" "$HORIZON_TRAVERSAL_SMOKE_REPORT_PATH"
fi

printf 'Packaged workflow assertions passed: %s\n' "$APP_BUNDLE"
SMOKE_SUCCEEDED=1
