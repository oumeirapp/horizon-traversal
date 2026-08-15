# Horizon Traversal

Horizon Traversal is a Tauri desktop application that collects approved assets from
ticket folders and prepares them for delivery. It discovers source folders,
copies supported files into flat `Master` and `Deliverables` areas inside each
ticket output, converts PDFs, resizes images and videos, and writes per-ticket
and aggregate CSV asset reports. It can also create one combined PowerPoint deck
with one content slide per ticket.

The installed application has no external Python or Node.js runtime dependency.
React renders the desktop interface, while Rust owns validation, filesystem
access, processing, run coordination, and native-tool execution. PowerPoint
package writing runs in the bundled, frozen `powerpoint-sidecar`; the webview
never launches it or receives filesystem access.

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

## PowerPoint workflow

The interface uses Radix tabs to separate `Asset processing` from
`PowerPoint only`. PowerPoint mode validates every visible immediate directory
in the selected root as a ticket, orders tickets naturally, and creates one
combined deck with one content slide per ticket. `02 · Process` reports the
current ticket and the active inspect, video, layout, compose, or save step.
The activity trace contains real native events, and an active run can be
cancelled cooperatively. A cancelled run never publishes a partial deck.

For each ticket, the generator reads only direct assets in `Master` and
`Deliverables` (matched case-insensitively). Master accepts at most two JPEG,
PNG, or GIF images. Deliverables accepts at most six total assets, including at
most two MP4 or AVI videos. Natural filename order and optional `slide.yaml`
priorities make selection deterministic. Videos are probed and receive a poster
frame, then their original container bytes are embedded without normalization,
resizing, or transcoding. AVI and non-H.264/AAC MP4 playback remains dependent
on the PowerPoint viewer and is reported as a compatibility warning.

If a ticket has no usable media, or any selected asset is corrupt, it still gets
a blank copy of the base template slide titled with the ticket folder name. The
template introduction slide remains unchanged. Successful runs publish
`Horizon Traversal.pptx` and `Horizon Traversal.layout-report.json` together in
the configured PowerPoint output folder.

Settings keep separate native-directory destinations for asset runs and
PowerPoint decks. Both `Asset output folder` and `PowerPoint output folder` are
editable and persisted. Their defaults are
`Downloads/horizon-traversal/output` and
`Downloads/horizon-traversal/pptx`. Asset input is checked only against the
asset destination, while PowerPoint input is checked only against the
PowerPoint destination; each pair must not be equal or overlap.

## Asset selection and reports

Within `Master Files`, an immediate child `Video` category is excluded, as is
every version-like descendant. In `Deliverables`, ordinary sibling folders are
traversed and only the highest numbered sibling version is entered. After that
version is selected, all of its descendants are traversed without another
version comparison.

Collected assets are flattened within `<output>/<ticket>/Master` or
`<output>/<ticket>/Deliverables` according to their discovered source root;
collision suffixes remain category-local. Each ticket with a discovered source
folder receives `report.csv` at the ticket root with the
columns `Name`, `Ticket`, `Folder`, and `Size`. The output root also receives
the aggregate `1. report.csv`, with that header once followed by all
ticket-report rows from the current run in ticket-processing order. This
aggregate is always written and is header-only when no ticket contributes a
row, including when tickets have no discovered source. The per-ticket
`report.csv` files remain available alongside their collected assets. `Name`
is the source basename with its original extension. Its full parsed size span
is removed from the stem, adjacent hyphens, underscores, and whitespace are
trimmed, and two retained sides are joined with one hyphen. Other case, spaces,
and punctuation are preserved. If removal would empty the stem, the original
basename is kept.
When normalized variants are grouped, the first representative provides the
displayed name. `Folder` is the asset's immediate child folder below its source
root. `Size` canonicalizes supported filename metadata: durations use
`<number> sec`, and aspect ratios or dimensions use ASCII `x` without
surrounding spaces. A `px` suffix is optional in the filename and is omitted
from the report; no other measurement unit is supported. When both a duration
and geometry are present, duration is written first and the two are separated
by one space. `Size` is `Unknown` when no supported token is present. Creative
variants are grouped only when their source root and exact `Folder` match and
their cleaned project path and `Name` match after case/punctuation
normalization; this normalization affects grouping only. Project-path cleaning
removes size-only components. Canonical sizes are deduplicated in first-seen
order and joined with a comma and no space. `Unknown` is retained alongside
known sizes, and a multi-value `Size` is CSV-quoted because it contains commas.
Copied files directly in a source root are omitted. A discovered source with no
reportable assets receives a header-only per-ticket report; a ticket with no
source folder receives no per-ticket `report.csv`.

The React webview uses focused typed commands for settings, selection, the asset
pipeline, and PowerPoint generation. It receives no shell, opener, or raw
filesystem capability. Rust alone invokes bundled FFmpeg/FFprobe and the frozen
PowerPoint sidecar and exposes scoped event channels rather than process access.

## Setup

The repository pins Node 24.14.0, npm 11.9.0, and Rust 1.96.0. Prepare the
checksum-pinned native inputs and generated media tools on the target host
before development:

```bash
npm ci
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run prepare:powerpoint-sidecar
npm run verify:native
npm run tauri dev
```

`prepare:pdfium` installs PDFium 151.0.7920.0. `prepare:ffmpeg` builds FFmpeg
8.1.2 and the pinned x264 revision. `prepare:powerpoint-sidecar` freezes the
manifest-driven generator with exact Python and Python-package versions, then
runs a real blank-slide manifest build against the verified template. The
resulting target-suffixed executable is generated and not committed. Apple
Silicon builds require the exact
macOS 26 / Command Line Tools 26.6 / SDK 26.5 toolchain recorded in
[`src-tauri/native-assets.json`](src-tauri/native-assets.json). Native Windows
x64 preparation downloads the checksum-pinned LLVM-MinGW UCRT, MSYS2 base,
GNU Make, and NASM inputs without using rolling packages. Preparation fails if
the target, toolchain, imports, or codecs differ. Source, toolchain-input,
PDFium, template, PowerPoint license-tree, and distribution-file hashes remain
pinned. Generated
FFmpeg, FFprobe, and PowerPoint sidecar executables are temporarily not
byte-pinned: verification checks their versions, target architecture, and
dynamic dependencies, checks media-tool capabilities, and reports their actual
SHA-256 hashes for audit.

Supported bundle targets are macOS 12 or newer on Apple Silicon and Windows
10/11 on x64. Each bundle must be built natively on its target platform.

The generated native binaries are intentionally not committed. Their pinned
inputs, target names, versions, configuration, codec capabilities, and
dependencies are validated by `npm run verify:native`; their actual hashes are
reported rather than compared with manifest output hashes.

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
installer, media and PowerPoint notices, their complete license trees, the
PowerPoint dependency inventory, and the corresponding-source ZIP.

These builds have no public publisher trust. macOS may require Control-click →
Open or approval in Privacy & Security. Windows may show SmartScreen's
“Unknown publisher” warning. Never globally disable Gatekeeper or SmartScreen.
Production publishing remains a later step and requires Developer ID signing,
the hardened runtime and notarization on macOS, Authenticode on Windows, and
the verified corresponding-source archive in a durable release location.

After the quality gates pass, GitHub Actions packages both applications on
pushes and manual workflow runs. Download the seven-day, explicitly non-release
macOS and Windows artifacts from the workflow run's **Artifacts** section.
Pull-request runs remain quality-only, and the jobs do not publish a GitHub
release.

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
`src-tauri/resources/licenses/pdfium/`. The frozen PowerPoint runtime and build
licenses, including Pillow's bundled native-library notices, are bundled under
`powerpoint/licenses/` and checksum-verified as one deterministic tree.

The PowerPoint dependency inventory pins exact versions and the accepted macOS
arm64 and Windows x64 wheel hashes. Sidecar preparation requires hash-verified,
binary-only artifacts in addition to semantically verifying the generated
executable.

## Project structure

```text
src/                         React/TypeScript interface and tests
src-tauri/src/               Tauri commands and Rust processing pipeline
src-tauri/binaries/          Notices and prepared target-suffixed executables
src-tauri/resources/         PDFium input and native license resources
src-tauri/tests/             Rust integration tests and fixtures
powerpoint-sidecar/          Manifest protocol, OOXML writer, template, and tests
scripts/                     Native preparation, verification, and smoke tools
.github/workflows/ci.yml     macOS/Windows quality and non-release package checks
```
