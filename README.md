# Horizon Traversal

Horizon Traversal is a Tauri desktop application that collects approved assets from
ticket folders and prepares them for delivery. It discovers source folders,
copies supported files into flat per-ticket outputs, converts PDFs, resizes
images and videos, and writes a source-path report.

The application has no Python or Node.js runtime dependency. React renders the
desktop interface, while Rust owns validation, filesystem access, processing,
run coordination, and native-tool execution.

## Architecture

The processing order is fixed and deterministic:

1. Discover source folders
2. Copy supported assets
3. Convert PDFs
4. Resize images
5. Resize videos
6. Generate the ticket report

PDF conversion, image resizing, and video resizing can be enabled independently
for each run. All three optimizations are enabled by default; disabled stages
remain visible in the route, log that they were skipped, and leave the copied
assets unchanged.

The React webview can call only three typed Rust commands: selection
validation, pipeline execution with a scoped event channel, and opening the
last Rust-stored output directory. It receives no shell, opener, or raw
filesystem capability. Rust invokes only the bundled FFmpeg and FFprobe
executables through Tauri's native shell API.

## Setup

The repository pins Node 24.14.0, npm 11.9.0, and Rust 1.96.0. On Apple
Silicon macOS, prepare the checksum-pinned native inputs before development:

```bash
npm ci
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run verify:native
npm run tauri dev
```

`prepare:pdfium` installs PDFium 151.0.7920.0. `prepare:ffmpeg` builds FFmpeg
8.1.2 and the pinned x264 revision. Native release builds require the exact
macOS 26 / Command Line Tools 26.6 / SDK 26.5 toolchain recorded in
[`src-tauri/native-assets.json`](src-tauri/native-assets.json); preparation
fails clearly if the toolchain or final hashes differ. The packaged app runs
on macOS 12 or newer.

The generated native binaries are intentionally not committed. Their source,
target names, versions, output hashes, dependencies, and distribution files
are validated by `npm run verify:native`.

## Checks

```bash
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

The manual Apple Silicon package smoke builds a test-enabled `.app`, verifies
native assets before signing, applies an ad-hoc local signature, validates the
signed bundle, and processes PDF, image, and PCM-audio video fixtures:

```bash
npm run smoke:package
```

That smoke bundle is test evidence only. It is not a signed, notarized, or
distributable release. Build the normal feature-off application with:

```bash
npm run tauri build
```

Production publishing must use the project's distribution identity, hardened
runtime/entitlements as applicable, notarization, and a Gatekeeper check.

## Native licensing

The FFmpeg/x264 configuration is GPL-covered. Every distributed application
must include the bundled notices and make the complete corresponding source
durably available beside the release:

```bash
npm run prepare:source-offer
(cd src-tauri/target/release-artifacts/native-source-offer && shasum -a 256 -c SHA256SUMS)
```

An expiring CI artifact is not a durable source offer. PDFium notices and the
complete pinned wheel license set are bundled under
`src-tauri/resources/licenses/pdfium/`.

## Project structure

```text
src/                         React/TypeScript interface and tests
src-tauri/src/               Tauri commands and Rust processing pipeline
src-tauri/binaries/          FFmpeg notices and prepared external binaries
src-tauri/resources/         PDFium input and native license resources
src-tauri/tests/             Rust integration tests and fixtures
scripts/                     Native preparation, verification, and smoke tools
.github/workflows/ci.yml     Frontend, Rust, native, and package-smoke checks
```
