# Bundled FFmpeg tools

Tauri expects the external binaries in this directory to include the Rust
target triple in their filenames:

```text
ffmpeg-aarch64-apple-darwin
ffprobe-aarch64-apple-darwin
ffmpeg-x86_64-pc-windows-msvc.exe
ffprobe-x86_64-pc-windows-msvc.exe
```

The corresponding `bundle.externalBin` entries omit the suffix and use
`binaries/ffmpeg` and `binaries/ffprobe`.

## Prepare the native binaries

From the repository root on the target host, run:

```bash
npm run prepare:ffmpeg
npm run verify:native
```

The Node dispatcher detects the Rust host triple and invokes the pinned builder
for Apple Silicon macOS or Windows x64. The macOS builder accepts two optional
environment variables:

- `JOBS`: positive build parallelism (defaults to the logical CPU count).
- `HORIZON_TRAVERSAL_KEEP_NATIVE_BUILD=1`: retain the temporary source and build
  tree for inspection.

The macOS build requires Apple Silicon and the pinned Xcode Command Line Tools.
The Windows build requires native Windows x64; its dispatcher downloads the
pinned LLVM-MinGW UCRT, MSYS2 base, GNU Make, and NASM inputs without using
rolling packages. Both builders download the exact FFmpeg and x264 archives
listed in `THIRD_PARTY_NOTICES.md`, verify every SHA-256 before extraction,
disable third-party autodetection, and reject undeclared dynamic dependencies.
The release output is reproducible only with the compilers, system versions,
and source epoch recorded in `../native-assets.json`; each builder verifies its
final binary hashes before installation.

A release build must prepare and verify the native files before invoking
Tauri:

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

Run `npm run prepare:source-offer` to download and checksum the exact FFmpeg and
x264 source archives. The command creates both
`src-tauri/target/release-artifacts/native-source-offer/` and the deterministic
`src-tauri/target/release-artifacts/Horizon-Traversal-native-source.zip`. It preserves the repository-relative
paths of the macOS builder, Windows builder, host dispatcher, native manifest,
notices, and GPL text. Run `npm run verify:source-offer` before publishing.

Publish the verified ZIP beside every application distribution in the same
durable release location. An expiring CI artifact is test evidence, not a
durable corresponding-source offer.
