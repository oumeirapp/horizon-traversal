#!/bin/sh

set -eu

FFMPEG_VERSION="8.1.2"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

require_file() {
  [ -f "$1" ] || fail "required bundle file is missing: $1"
}

require_executable() {
  require_file "$1"
  [ -x "$1" ] || fail "bundle executable bit is missing: $1"
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

verify_arm64() {
  binary=$1
  label=$2
  architectures=$(lipo -archs "$binary")
  case " $architectures " in
    *" arm64 "*)
      ;;
    *)
      fail "$label does not contain an arm64 slice: $architectures"
      ;;
  esac
  printf '%s architecture: %s\n' "$label" "$architectures"
}

inspect_dependencies() {
  binary=$1
  label=$2
  allowed_install_name=$3
  dependencies=$(otool -L "$binary" | awk 'NR > 1 { print $1 }')
  unexpected=$(printf '%s\n' "$dependencies" | awk -v allowed_install_name="$allowed_install_name" '
    NF &&
    $0 != allowed_install_name &&
    $0 !~ "^/System/Library/" &&
    $0 !~ "^/usr/lib/" &&
    $0 !~ "^@rpath/" &&
    $0 !~ "^@loader_path/" &&
    $0 !~ "^@executable_path/" {
      print
    }
  ')
  printf '%s dependencies:\n' "$label"
  if [ -n "$dependencies" ]; then
    printf '  %s\n' "$dependencies"
  else
    printf '  (none)\n'
  fi
  [ -z "$unexpected" ] ||
    fail "$label has non-portable dynamic dependencies: $unexpected"
}

verify_supports_macos_12() {
  binary=$1
  label=$2
  minimum=$(otool -l "$binary" | awk '
    $1 == "cmd" && $2 == "LC_BUILD_VERSION" { build_version = 1; next }
    build_version && $1 == "minos" { print $2; exit }
  ')
  [ -n "$minimum" ] || fail "$label has no LC_BUILD_VERSION minimum"
  if ! awk -v version="$minimum" 'BEGIN {
    split(version, parts, ".")
    exit !((parts[1] + 0) < 12 || ((parts[1] + 0) == 12 && (parts[2] + 0) == 0))
  }'; then
    fail "$label requires macOS $minimum and cannot run on the supported macOS 12 baseline"
  fi
  printf '%s LC_BUILD_VERSION minos: %s\n' "$label" "$minimum"
}

print_and_verify_hash() {
  binary=$1
  label=$2
  expected=$3
  actual=$(sha256 "$binary")
  printf '%s SHA-256: %s\n' "$label" "$actual"
  if [ -n "$expected" ] && [ "$actual" != "$expected" ]; then
    fail "$label checksum mismatch: expected $expected, received $actual"
  fi
}

[ "$#" -eq 1 ] || fail "usage: $0 /path/to/Horizon\\ Traversal.app"
[ "$(uname -s)" = "Darwin" ] || fail "bundle inspection requires macOS"

for command in awk codesign grep lipo otool plutil shasum uname; do
  require_command "$command"
done
require_file "/usr/libexec/PlistBuddy"

APP_BUNDLE=$1
[ -d "$APP_BUNDLE/Contents" ] || fail "not a macOS application bundle: $APP_BUNDLE"

INFO_PLIST="$APP_BUNDLE/Contents/Info.plist"
require_file "$INFO_PLIST"
EXECUTABLE_NAME=$(/usr/libexec/PlistBuddy -c "Print :CFBundleExecutable" "$INFO_PLIST")
PLIST_MINIMUM=$(/usr/libexec/PlistBuddy -c "Print :LSMinimumSystemVersion" "$INFO_PLIST")
[ "$PLIST_MINIMUM" = "12.0" ] ||
  fail "Info.plist LSMinimumSystemVersion must be 12.0, received $PLIST_MINIMUM"
case "$EXECUTABLE_NAME" in
  '' | */*)
    fail "Info.plist contains an invalid CFBundleExecutable: $EXECUTABLE_NAME"
    ;;
esac

APP_EXECUTABLE="$APP_BUNDLE/Contents/MacOS/$EXECUTABLE_NAME"
FFMPEG="$APP_BUNDLE/Contents/MacOS/ffmpeg"
FFPROBE="$APP_BUNDLE/Contents/MacOS/ffprobe"
PDFIUM="$APP_BUNDLE/Contents/Frameworks/libpdfium.dylib"
THIRD_PARTY_NOTICES="$APP_BUNDLE/Contents/Resources/binaries/THIRD_PARTY_NOTICES.md"
GPL_LICENSE="$APP_BUNDLE/Contents/Resources/binaries/licenses/GPL-2.0-or-later.txt"
NATIVE_MANIFEST="$APP_BUNDLE/Contents/Resources/native-assets.json"

require_executable "$APP_EXECUTABLE"
require_executable "$FFMPEG"
require_executable "$FFPROBE"
require_file "$PDFIUM"
require_file "$THIRD_PARTY_NOTICES"
require_file "$GPL_LICENSE"
require_file "$NATIVE_MANIFEST"

plutil -convert json -o /dev/null "$NATIVE_MANIFEST" ||
  fail "bundled native asset manifest is not valid JSON"
MANIFEST_SCHEMA=$(plutil -extract schemaVersion raw -o - "$NATIVE_MANIFEST")
[ "$MANIFEST_SCHEMA" = "1" ] || fail "unsupported native asset manifest schema: $MANIFEST_SCHEMA"
FFMPEG_SHA256=$(plutil -extract 'targets.aarch64-apple-darwin.ffmpeg.sha256' raw -o - "$NATIVE_MANIFEST")
FFPROBE_SHA256=$(plutil -extract 'targets.aarch64-apple-darwin.ffprobe.sha256' raw -o - "$NATIVE_MANIFEST")
PDFIUM_SHA256=$(plutil -extract 'targets.aarch64-apple-darwin.pdfium.sha256' raw -o - "$NATIVE_MANIFEST")

if [ "${HORIZON_TRAVERSAL_SKIP_CODESIGN_VERIFY:-0}" = "1" ]; then
  printf '%s\n' 'Code-signature verification skipped explicitly for this local unsigned smoke bundle.'
  CODE_SIGNATURE_VERIFIED=0
else
  codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" ||
    fail "bundle code signature is invalid; set HORIZON_TRAVERSAL_SKIP_CODESIGN_VERIFY=1 only for a local unsigned smoke build"
  CODE_SIGNATURE_VERIFIED=1
fi

verify_arm64 "$APP_EXECUTABLE" "application"
verify_arm64 "$FFMPEG" "ffmpeg"
verify_arm64 "$FFPROBE" "ffprobe"
verify_arm64 "$PDFIUM" "PDFium"

verify_supports_macos_12 "$APP_EXECUTABLE" "application"
verify_supports_macos_12 "$FFMPEG" "ffmpeg"
verify_supports_macos_12 "$FFPROBE" "ffprobe"
verify_supports_macos_12 "$PDFIUM" "PDFium"

inspect_dependencies "$APP_EXECUTABLE" "application" ""
inspect_dependencies "$FFMPEG" "ffmpeg" ""
inspect_dependencies "$FFPROBE" "ffprobe" ""
inspect_dependencies "$PDFIUM" "PDFium" "./libpdfium.dylib"

FFMPEG_OUTPUT=$("$FFMPEG" -hide_banner -version 2>&1)
printf '%s\n' "$FFMPEG_OUTPUT" | grep -F "ffmpeg version $FFMPEG_VERSION" >/dev/null ||
  fail "ffmpeg did not report pinned version $FFMPEG_VERSION"
printf '%s\n' "$FFMPEG_OUTPUT" | grep -F -- "--enable-gpl" >/dev/null ||
  fail "ffmpeg was not built with GPL support"
printf '%s\n' "$FFMPEG_OUTPUT" | grep -F -- "--enable-libx264" >/dev/null ||
  fail "ffmpeg was not built with libx264"

FFPROBE_OUTPUT=$("$FFPROBE" -hide_banner -version 2>&1)
printf '%s\n' "$FFPROBE_OUTPUT" | grep -F "ffprobe version $FFMPEG_VERSION" >/dev/null ||
  fail "ffprobe did not report pinned version $FFMPEG_VERSION"

printf 'ffmpeg version: %s\n' "$(printf '%s\n' "$FFMPEG_OUTPUT" | awk 'NR == 1 { print $3 }')"
printf 'ffprobe version: %s\n' "$(printf '%s\n' "$FFPROBE_OUTPUT" | awk 'NR == 1 { print $3 }')"
print_and_verify_hash "$APP_EXECUTABLE" "application" "${HORIZON_TRAVERSAL_APP_SHA256:-}"
if [ "$CODE_SIGNATURE_VERIFIED" = "1" ]; then
  # Mach-O code signatures change the byte-level digest. The deep signature
  # check above authenticates signed nested code; the source manifest digests
  # remain visible here for the corresponding pre-signing asset inspection.
  printf 'ffmpeg source SHA-256: %s\n' "$FFMPEG_SHA256"
  printf 'ffprobe source SHA-256: %s\n' "$FFPROBE_SHA256"
  printf 'PDFium source SHA-256: %s\n' "$PDFIUM_SHA256"
  FFMPEG_EXPECTED=${HORIZON_TRAVERSAL_FFMPEG_SHA256:-}
  FFPROBE_EXPECTED=${HORIZON_TRAVERSAL_FFPROBE_SHA256:-}
  PDFIUM_EXPECTED=${HORIZON_TRAVERSAL_PDFIUM_SHA256:-}
else
  FFMPEG_EXPECTED=${HORIZON_TRAVERSAL_FFMPEG_SHA256:-$FFMPEG_SHA256}
  FFPROBE_EXPECTED=${HORIZON_TRAVERSAL_FFPROBE_SHA256:-$FFPROBE_SHA256}
  PDFIUM_EXPECTED=${HORIZON_TRAVERSAL_PDFIUM_SHA256:-$PDFIUM_SHA256}
fi
print_and_verify_hash "$FFMPEG" "ffmpeg" "$FFMPEG_EXPECTED"
print_and_verify_hash "$FFPROBE" "ffprobe" "$FFPROBE_EXPECTED"
print_and_verify_hash "$PDFIUM" "PDFium" "$PDFIUM_EXPECTED"
print_and_verify_hash "$NATIVE_MANIFEST" "native asset manifest" ""

distribution_index=0
pdfium_license_count=0
while distribution_path=$(plutil -extract "distributionFiles.$distribution_index.path" raw -o - "$NATIVE_MANIFEST" 2>/dev/null); do
  distribution_hash=$(plutil -extract "distributionFiles.$distribution_index.sha256" raw -o - "$NATIVE_MANIFEST")
  case "$distribution_path" in
    src-tauri/*)
      bundle_relative=${distribution_path#src-tauri/}
      ;;
    *)
      fail "distribution manifest path is outside src-tauri: $distribution_path"
      ;;
  esac
  distribution_file="$APP_BUNDLE/Contents/Resources/$bundle_relative"
  require_file "$distribution_file"
  print_and_verify_hash "$distribution_file" "$bundle_relative" "$distribution_hash"
  case "$bundle_relative" in
    resources/licenses/pdfium/*)
      pdfium_license_count=$((pdfium_license_count + 1))
      ;;
  esac
  distribution_index=$((distribution_index + 1))
done
[ "$distribution_index" -gt 0 ] || fail "native asset manifest has no distribution files"
[ "$pdfium_license_count" -gt 3 ] ||
  fail "bundled PDFium license set is incomplete: only $pdfium_license_count files"

printf 'Bundle inspection passed: %s\n' "$APP_BUNDLE"
