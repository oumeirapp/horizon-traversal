# Bundled FFmpeg tools

Tauri expects the external binaries in this directory to include the Rust
target triple in their filenames:

```text
ffmpeg-aarch64-apple-darwin
ffprobe-aarch64-apple-darwin
```

The corresponding `bundle.externalBin` entries omit the suffix and use
`binaries/ffmpeg` and `binaries/ffprobe`.

## Prepare the Apple Silicon binaries

From the repository root, run:

```bash
./scripts/build-native-macos-arm64.sh
```

The script accepts two optional environment variables:

- `JOBS`: positive build parallelism (defaults to the logical CPU count).
- `HORIZON_TRAVERSAL_KEEP_NATIVE_BUILD=1`: retain the temporary source and build
  tree for inspection.

The build requires macOS on Apple Silicon, Xcode Command Line Tools, and an
internet connection. It downloads the exact FFmpeg and x264 archives listed
in `THIRD_PARTY_NOTICES.md`, verifies SHA-256 before extraction, disables
third-party autodetection, and rejects non-system dynamic dependencies. The
release output is reproducible only with the compiler, Command Line Tools, and
SDK versions pinned in `../native-assets.json`; the script rejects any other
toolchain and verifies the final binary hashes before installation. A release
build must prepare and verify these files before invoking Tauri:

```bash
npm run prepare:ffmpeg
npm run verify:native
```

The generated executables are build artifacts. Do not commit them. Tauri signs
and bundles them as part of the application release process.

## Release obligations

FFmpeg is built with `--enable-gpl --enable-libx264`; therefore the generated
FFmpeg and FFprobe executables are GPL-covered. Every distributed application
release must also distribute the notices, license, and complete corresponding
source described in `THIRD_PARTY_NOTICES.md`.

Prepare the corresponding-source directory with `npm run
prepare:source-offer`, verify its `SHA256SUMS`, and publish it beside the app in
the same durable release location. An expiring CI artifact is not a durable
source offer.
