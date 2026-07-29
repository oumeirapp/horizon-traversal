#!/bin/sh

set -eu

# Request files use the frontend selection shape plus an absolute report path:
# {"inputPath":"/…","outputPath":"/…","ticketFilter":"P1-P3","resultPath":"/…/result.json"}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "required file is missing: $1"
}

[ "$#" -eq 2 ] ||
  fail "usage: $0 /path/to/X\\ Traversal.app /absolute/path/to/request.json"
[ "$(uname -s)" = "Darwin" ] || fail "packaged smoke tests require macOS"
[ "$(uname -m)" = "arm64" ] || fail "packaged smoke tests must run natively on Apple Silicon"
command -v plutil >/dev/null 2>&1 || fail "plutil is unavailable"

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSPECTOR="$SCRIPT_DIRECTORY/../inspect-bundle-macos-arm64.sh"
APP_BUNDLE=$1
REQUEST_FILE=$2

require_file "$INSPECTOR"
require_file "$REQUEST_FILE"
"$INSPECTOR" "$APP_BUNDLE"

INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
EXECUTABLE_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$INFO_PLIST")
APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
require_file "$APP_EXECUTABLE"
[ -x "$APP_EXECUTABLE" ] || fail "application executable bit is missing: $APP_EXECUTABLE"

plutil -convert json -o /dev/null "$REQUEST_FILE" ||
  fail "request is not valid JSON: $REQUEST_FILE"
RESULT_PATH=$(plutil -extract resultPath raw -o - "$REQUEST_FILE")
case "$RESULT_PATH" in
  /*)
    ;;
  *)
    fail "request resultPath must be absolute: $RESULT_PATH"
    ;;
esac
[ ! -e "$RESULT_PATH" ] ||
  fail "request resultPath already exists; use a fresh path: $RESULT_PATH"

REQUEST_JSON=$(cat "$REQUEST_FILE")
TIMEOUT_SECONDS=${X_TRAVERSAL_SMOKE_TIMEOUT_SECONDS:-180}
case "$TIMEOUT_SECONDS" in
  '' | *[!0-9]* | 0)
    fail "X_TRAVERSAL_SMOKE_TIMEOUT_SECONDS must be a positive integer"
    ;;
esac

X_TRAVERSAL_PACKAGED_SMOKE_REQUEST="$REQUEST_JSON" "$APP_EXECUTABLE" &
APP_PID=$!
elapsed=0
while kill -0 "$APP_PID" 2>/dev/null; do
  if [ "$elapsed" -ge "$TIMEOUT_SECONDS" ]; then
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
    fail "packaged app did not finish within ${TIMEOUT_SECONDS}s; was it built with --features packaged-smoke?"
  fi
  sleep 1
  elapsed=$((elapsed + 1))
done

set +e
wait "$APP_PID"
APP_STATUS=$?
set -e

require_file "$RESULT_PATH"
plutil -convert json -o /dev/null "$RESULT_PATH" ||
  fail "packaged smoke result is not valid JSON: $RESULT_PATH"
OUTCOME=$(plutil -extract outcome raw -o - "$RESULT_PATH")

if [ "$APP_STATUS" -ne 0 ] || [ "$OUTCOME" != "passed" ]; then
  printf 'Packaged smoke report: %s\n' "$RESULT_PATH" >&2
  fail "packaged workflow failed with process status $APP_STATUS and outcome $OUTCOME"
fi

printf 'Packaged smoke passed: %s\n' "$RESULT_PATH"
