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
are omitted from the visible route and leave the copied assets unchanged.

The React webview can call only three typed Rust commands: selection
validation, pipeline execution with a scoped event channel, and opening the
last Rust-stored output directory. It receives no shell, opener, or raw
filesystem capability. Rust invokes only the bundled FFmpeg and FFprobe
executables through Tauri's native shell API.

## Setup

The repository pins Node 24.14.0, npm 11.9.0, and Rust 1.96.0. Prepare the
checksum-pinned native inputs on the target host before development:

```bash
npm ci
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run verify:native
npm run tauri dev
```

`prepare:pdfium` installs PDFium 151.0.7920.0. `prepare:ffmpeg` builds FFmpeg
8.1.2 and the pinned x264 revision. Apple Silicon builds require the exact
macOS 26 / Command Line Tools 26.6 / SDK 26.5 toolchain recorded in
[`src-tauri/native-assets.json`](src-tauri/native-assets.json). Native Windows
x64 preparation downloads the checksum-pinned LLVM-MinGW UCRT, MSYS2 base,
GNU Make, and NASM inputs without using rolling packages. Preparation fails if
the target, toolchain, imports, codecs, or final hashes differ.

Supported bundle targets are macOS 12 or newer on Apple Silicon and Windows
10/11 on x64. Each bundle must be built natively on its target platform.

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

## Unsigned bundle testing

The package smoke command selects the native Apple Silicon macOS or Windows
x64 runner. It builds an isolated test-enabled package, inspects the installed
native assets, and processes PDF, oversized-image, and audio-video fixtures:

```bash
npm run smoke:package
```

That smoke package is test evidence only and is kept separate from normal
feature-off bundles. Build the current unverified distributions with:

```bash
npm run bundle:macos
# or, on native Windows x64
npm run bundle:windows
```

The macOS command produces an ad-hoc-signed `.app` and `.dmg` without hardened
runtime or notarization. The Windows command produces one unsigned,
current-user NSIS installer; it does not build an MSI and does not require
elevation. Both commands verify the native inputs and create a checksummed
companion directory under `src-tauri/target/release-artifacts/` containing the
installer, notices, licenses, and corresponding-source ZIP.

These builds have no public publisher trust. macOS may require Control-click →
Open or approval in Privacy & Security. Windows may show SmartScreen's
“Unknown publisher” warning. Never globally disable Gatekeeper or SmartScreen.
Production publishing remains a later step and requires Developer ID signing,
the hardened runtime and notarization on macOS, Authenticode on Windows, and
the verified corresponding-source archive in a durable release location.

The manual GitHub Actions package jobs create explicitly non-release evidence.
They do not publish a GitHub release.

## Native licensing

The FFmpeg/x264 configuration is GPL-covered. Every distributed application
must include the bundled notices and make the complete corresponding source
durably available beside the release:

```bash
npm run prepare:source-offer
npm run verify:source-offer
```

The deterministic ZIP is written to
`src-tauri/target/release-artifacts/Horizon-Traversal-native-source.zip`.
An expiring CI artifact is test evidence, not a durable source offer. PDFium
notices and the complete pinned wheel license set are bundled under
`src-tauri/resources/licenses/pdfium/`.

## Project structure

```text
src/                         React/TypeScript interface and tests
src-tauri/src/               Tauri commands and Rust processing pipeline
src-tauri/binaries/          FFmpeg notices and prepared external binaries
src-tauri/resources/         PDFium input and native license resources
src-tauri/tests/             Rust integration tests and fixtures
scripts/                     Native preparation, verification, and smoke tools
.github/workflows/ci.yml     macOS/Windows quality and non-release package checks
```
