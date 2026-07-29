#!/bin/sh

set -eu

FFMPEG_VERSION="8.1.2"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
FFMPEG_SHA256="464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c"

X264_REVISION="b35605ace3ddf7c1a5d67a2eb553f034aef41d55"
X264_ARCHIVE="x264-${X264_REVISION}.tar.bz2"
X264_URL="https://code.videolan.org/videolan/x264/-/archive/${X264_REVISION}/${X264_ARCHIVE}"
X264_SHA256="6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224"

TARGET_TRIPLE="aarch64-apple-darwin"
MACOS_DEPLOYMENT_TARGET="12.0"
# Timestamp carried by the FFmpeg 8.1.2 release archive (UTC).
SOURCE_DATE_EPOCH="1781678760"

SCRIPT_DIRECTORY=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "${SCRIPT_DIRECTORY}/.." && pwd)
OUTPUT_DIRECTORY=${X_TRAVERSAL_NATIVE_OUTPUT_DIR:-"${REPOSITORY_ROOT}/src-tauri/binaries"}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

sha256() {
  shasum -a 256 "$1" | awk '{print $1}'
}

download_verified() {
  source_url=$1
  destination=$2
  expected_digest=$3

  printf 'Downloading %s\n' "$source_url"
  curl \
    --fail \
    --location \
    --proto '=https' \
    --retry 3 \
    --show-error \
    --silent \
    --tlsv1.2 \
    --output "$destination" \
    "$source_url"

  actual_digest=$(sha256 "$destination")
  if [ "$actual_digest" != "$expected_digest" ]; then
    fail "checksum mismatch for $(basename -- "$destination"): expected ${expected_digest}, received ${actual_digest}"
  fi
}

verify_system_dependencies() {
  binary=$1

  for dependency in $(otool -L "$binary" | awk 'NR > 1 { print $1 }'); do
    case "$dependency" in
      /System/Library/* | /usr/lib/*)
        ;;
      *)
        fail "$(basename -- "$binary") has a non-system dynamic dependency: ${dependency}"
        ;;
    esac
  done
}

verify_binary() {
  binary=$1
  program=$2

  architectures=$(lipo -archs "$binary")
  [ "$architectures" = "arm64" ] || fail "${program} has unexpected architectures: ${architectures}"
  verify_system_dependencies "$binary"

  version_output=$("$binary" -hide_banner -version 2>&1)
  printf '%s\n' "$version_output" | grep -F "${program} version ${FFMPEG_VERSION}" >/dev/null ||
    fail "${program} did not report pinned version ${FFMPEG_VERSION}"
}

cleanup() {
  if [ "${KEEP_BUILD_DIRECTORY:-0}" = "1" ]; then
    printf 'Build directory retained at %s\n' "$WORK_DIRECTORY"
    return
  fi

  case "$WORK_DIRECTORY" in
    "${TMPDIR:-/tmp}"/x-traversal-native.*)
      rm -rf -- "$WORK_DIRECTORY"
      ;;
    *)
      printf 'Refusing to remove unexpected build directory: %s\n' "$WORK_DIRECTORY" >&2
      ;;
  esac
}

[ "$(uname -s)" = "Darwin" ] || fail "this builder supports macOS only"
[ "$(uname -m)" = "arm64" ] || fail "this builder must run natively on Apple Silicon"

for required in awk basename chmod clang curl grep install lipo make mkdir mktemp mv otool ranlib sed shasum strip sysctl tar xcrun; do
  require_command "$required"
done

JOBS=${JOBS:-$(sysctl -n hw.logicalcpu)}
case "$JOBS" in
  '' | *[!0-9]* | 0)
    fail "JOBS must be a positive integer"
    ;;
esac

WORK_DIRECTORY=$(mktemp -d "${TMPDIR:-/tmp}/x-traversal-native.XXXXXX")
export WORK_DIRECTORY
export KEEP_BUILD_DIRECTORY=${X_TRAVERSAL_KEEP_NATIVE_BUILD:-0}
trap cleanup EXIT HUP INT TERM

DOWNLOAD_DIRECTORY="${WORK_DIRECTORY}/downloads"
SOURCE_DIRECTORY="${WORK_DIRECTORY}/sources"
X264_PREFIX="${WORK_DIRECTORY}/x264-prefix"
STAGING_DIRECTORY="${WORK_DIRECTORY}/staging"
mkdir -p "$DOWNLOAD_DIRECTORY" "$SOURCE_DIRECTORY" "$X264_PREFIX" "$STAGING_DIRECTORY"

FFMPEG_SOURCE_ARCHIVE="${DOWNLOAD_DIRECTORY}/${FFMPEG_ARCHIVE}"
X264_SOURCE_ARCHIVE="${DOWNLOAD_DIRECTORY}/${X264_ARCHIVE}"
download_verified "$FFMPEG_URL" "$FFMPEG_SOURCE_ARCHIVE" "$FFMPEG_SHA256"
download_verified "$X264_URL" "$X264_SOURCE_ARCHIVE" "$X264_SHA256"

tar -xJf "$FFMPEG_SOURCE_ARCHIVE" -C "$SOURCE_DIRECTORY"
tar -xjf "$X264_SOURCE_ARCHIVE" -C "$SOURCE_DIRECTORY"

SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
CC=$(xcrun --sdk macosx --find clang)
CXX=$(xcrun --sdk macosx --find clang++)
AR=$(xcrun --sdk macosx --find ar)
RANLIB=$(xcrun --sdk macosx --find ranlib)
STRIP=$(xcrun --sdk macosx --find strip)

export SDKROOT CC CXX AR RANLIB STRIP
export MACOSX_DEPLOYMENT_TARGET="$MACOS_DEPLOYMENT_TARGET"
export SOURCE_DATE_EPOCH
export ZERO_AR_DATE=1
export LC_ALL=C
export LANG=C
export TZ=UTC

REPRODUCIBLE_CFLAGS="-arch arm64 -mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET} -O2"
REPRODUCIBLE_LDFLAGS="-arch arm64 -mmacosx-version-min=${MACOS_DEPLOYMENT_TARGET}"

printf 'Building x264 revision %s\n' "$X264_REVISION"
(
  cd "${SOURCE_DIRECTORY}/x264-${X264_REVISION}"
  CFLAGS="$REPRODUCIBLE_CFLAGS" \
  LDFLAGS="$REPRODUCIBLE_LDFLAGS" \
    ./configure \
      --prefix="$X264_PREFIX" \
      --host="$TARGET_TRIPLE" \
      --enable-static \
      --disable-cli \
      --disable-opencl \
      --disable-lavf \
      --disable-swscale \
      --disable-ffms \
      --disable-gpac \
      --bit-depth=8 \
      --extra-cflags="$REPRODUCIBLE_CFLAGS" \
      --extra-ldflags="$REPRODUCIBLE_LDFLAGS"
  make -j "$JOBS"
  make install-lib-static
)

# FFmpeg requires pkg-config to discover libx264. This narrow shim reports only
# the just-built, checksum-verified x264 prefix, avoiding accidental Homebrew or
# system dependency discovery.
PKG_CONFIG_SHIM="${WORK_DIRECTORY}/pkg-config-x264"
X264_DISCOVERY_PREFIX="../../x264-prefix"
sed \
  -e "s|@X264_PREFIX@|${X264_DISCOVERY_PREFIX}|g" \
  >"$PKG_CONFIG_SHIM" <<'PKG_CONFIG_EOF'
#!/bin/sh
set -eu

mode=
package_seen=0

for argument in "$@"; do
  case "$argument" in
    --version)
      mode=version
      ;;
    --exists | --print-errors | --static)
      ;;
    --cflags)
      mode=cflags
      ;;
    --cflags-only-I)
      mode=cflags
      ;;
    --libs)
      mode=libs
      ;;
    --variable=includedir)
      mode=includedir
      ;;
    x264 | x264\ *)
      package_seen=1
      ;;
  esac
done

if [ "$mode" = "version" ]; then
  printf 'x-traversal-pkg-config-shim 1\n'
  exit 0
fi

[ "$package_seen" = "1" ] || exit 1

case "$mode" in
  '')
    exit 0
    ;;
  cflags)
    printf '%s\n' '-I@X264_PREFIX@/include'
    ;;
  includedir)
    printf '%s\n' '@X264_PREFIX@/include'
    ;;
  libs)
    printf '%s\n' '-L@X264_PREFIX@/lib -lx264 -lm -lpthread'
    ;;
  *)
    exit 1
    ;;
esac
PKG_CONFIG_EOF
chmod 0755 "$PKG_CONFIG_SHIM"

printf 'Building FFmpeg %s\n' "$FFMPEG_VERSION"
(
  cd "${SOURCE_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}"
  ./configure \
    --prefix=/usr/local \
    --arch=arm64 \
    --target-os=darwin \
    --cc="$CC" \
    --cxx="$CXX" \
    --ar="$AR" \
    --ranlib="$RANLIB" \
    --strip="$STRIP" \
    --pkg-config=../../pkg-config-x264 \
    --pkg-config-flags=--static \
    --enable-gpl \
    --enable-libx264 \
    --enable-static \
    --disable-shared \
    --disable-autodetect \
    --disable-debug \
    --disable-doc \
    --disable-network \
    --disable-ffplay \
    --enable-ffmpeg \
    --enable-ffprobe \
    --extra-cflags="${REPRODUCIBLE_CFLAGS} -I${X264_DISCOVERY_PREFIX}/include" \
    --extra-ldflags="${REPRODUCIBLE_LDFLAGS} -L${X264_DISCOVERY_PREFIX}/lib"
  make -j "$JOBS" ffmpeg ffprobe
)

mkdir -p "$OUTPUT_DIRECTORY"
for program in ffmpeg ffprobe; do
  source_binary="${SOURCE_DIRECTORY}/ffmpeg-${FFMPEG_VERSION}/${program}"
  staged_binary="${STAGING_DIRECTORY}/${program}-${TARGET_TRIPLE}"

  install -m 0755 "$source_binary" "$staged_binary"
  "$STRIP" -x "$staged_binary"
  verify_binary "$staged_binary" "$program"
done

STAGED_FFMPEG="${STAGING_DIRECTORY}/ffmpeg-${TARGET_TRIPLE}"
"$STAGED_FFMPEG" -hide_banner -encoders 2>/dev/null | grep -F libx264 >/dev/null ||
  fail "the FFmpeg build does not contain the libx264 encoder"
"$STAGED_FFMPEG" -hide_banner -encoders 2>/dev/null | grep -E '[[:space:]]aac[[:space:]]' >/dev/null ||
  fail "the FFmpeg build does not contain the AAC encoder"

for program in ffmpeg ffprobe; do
  staged_binary="${STAGING_DIRECTORY}/${program}-${TARGET_TRIPLE}"
  destination="${OUTPUT_DIRECTORY}/${program}-${TARGET_TRIPLE}"
  mv -f "$staged_binary" "$destination"
  printf 'Prepared %s (%s)\n' "$destination" "$(sha256 "$destination")"
done

printf 'Native media tools are ready for %s.\n' "$TARGET_TRIPLE"
