# AGENTS.md

# Horizon Traversal

Horizon Traversal is a Tauri v2 desktop application for collecting approved assets
from ticket folders. React/TypeScript owns presentation; Rust owns validation,
filesystem traversal, media processing, reports, run state, and native tools.

## Technology and structure

- `src/`: React 19, TypeScript, Vite, ordinary CSS, and Vitest tests.
- `src-tauri/src/`: Rust pipeline and the narrow Tauri command boundary.
- `src-tauri/tests/`: Rust unit/integration fixtures.
- `scripts/`: native preparation, checksum, bundle inspection, and smoke tools.
- Node 24.14.0 with npm 11.9.0; Rust 1.96.0.

Do not add Python or Node sidecars. Do not access the filesystem or spawn
programs from the React webview.

## Package management and commands

Use npm for frontend/Tauri tooling and Cargo for Rust. Do not use pnpm, Yarn,
or another JavaScript package manager.

```bash
npm ci
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run verify:native
npm run tauri dev
npm run bundle:macos
npm run bundle:windows
npm run verify:source-offer
npm test
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

## Architecture rules

- Preserve the deterministic stage order: discover, copy, PDF, images, video,
  report.
- Keep PDF, image, and video optimization independently selectable per run,
  with all three enabled by default.
- Keep output flat and isolated per ticket; do not change collision naming or
  report scope without an explicit requirement.
- Under `Master Files`, exclude the immediate child `Video` category and all
  version-like descendants. Under `Deliverables`, traverse ordinary sibling
  folders and enter only the highest numbered sibling version; once selected,
  traverse all descendants without another version comparison.
- Preserve the per-ticket `report.csv` contract: `Name,Ticket,Folder,Size`, with
  `Folder` taken from the immediate child below the source root. Canonicalize
  filename duration as `<number> sec` and geometry with ASCII `x` and no
  surrounding spaces. Accept an optional `px` suffix and omit it from output;
  no other measurement unit is supported. When both are present, write duration
  first, then one space, then geometry; use `Unknown` when neither is present.
- Preserve the output-root aggregate named exactly `1. report.csv`. It uses the
  per-ticket CSV header once and contains every ticket-report row from the
  current run in ticket-processing order. Always write it, using a header-only
  aggregate when no ticket contributes rows, including when tickets have no
  discovered source. Do not remove or rename the per-ticket `report.csv` files.
- Derive `Name` from the source basename: remove the full parsed size span from
  the stem, trim adjacent hyphens, underscores, and whitespace, join two
  retained sides with one hyphen, and append the original extension. Preserve
  other case, spaces, and punctuation. Keep the original basename if removal
  would empty the stem; the first grouped representative supplies the displayed
  name.
- Group report creatives by source root, exact folder, normalized cleaned
  project path, and normalized cleaned `Name`. Normalization is for grouping
  only. Deduplicate canonical sizes in first-seen order, retain `Unknown`, and
  join multiple sizes with a comma and no space, applying normal CSV quoting.
  Omit copied files directly in a source root, and write a header-only
  per-ticket report when a discovered source has nothing reportable; write no
  per-ticket `report.csv` when no source is discovered.
- Keep `src-tauri/src/main.rs` thin and application setup in `lib.rs`.
- Expose only focused, typed Tauri commands. Never grant shell, opener, or
  filesystem plugin permissions to the webview.
- Run blocking filesystem/media work outside the UI thread and keep ticket
  failures isolated.
- Skip symlinks and reject overlapping input/output paths.
- Preserve cross-platform path handling for the pinned macOS arm64 and Windows
  x64 bundle targets.

## UI rules

- Keep the navy/teal identity and six native processing stages. The optional
  frontend-only PPTX preview may add its unavailable seventh route stop.
- Keep the workflow split in Radix tabs named `Asset processing` and
  `PowerPoint only`.
- Keep the PowerPoint (`.pptx`) option in `Asset processing` off by default,
  frontend-only, and unavailable. It must not alter or enter the Rust pipeline.
- In `PowerPoint only`, validate the selected root for the planned combined
  deck model, with one ticket per future slide. Keep `Create PowerPoint`
  disabled and keep the preview and activity surfaces as non-generating
  scaffolding.
- Do not generate PowerPoint files or add PowerPoint-specific Rust commands or
  IPC until that backend work is explicitly approved.
- Keep separate persisted output settings: `defaultOutputPath` for asset runs
  and `powerpointOutputPath` for future decks. Expose both through editable
  native directory-picker controls, while leaving the PowerPoint destination
  unused until generation is implemented. Default them to
  `Downloads/horizon-traversal/output` and
  `Downloads/horizon-traversal/pptx`. Validate each workflow's input only
  against its corresponding output, rejecting equality or ancestry overlap.
- Preserve keyboard navigation, visible focus, accessible contrast, and
  reduced-motion behavior.
- Keep event ingestion batched and log rendering bounded; avoid rerender churn
  in the activity panel.
- Use native directory dialogs only through the existing narrow integration.

## Native packaging

- FFmpeg/FFprobe run only from Rust and remain suffix-free in `externalBin`.
- Keep source, toolchain-input, PDFium, and distribution-file hashes, toolchain
  identity, license resources, and Tauri bundle declarations synchronized with
  `src-tauri/native-assets.json`.
- Generated FFmpeg/FFprobe executables are temporarily not byte-pinned.
  Semantically verify their versions, configuration, codecs, and dynamic
  dependencies, and report their actual SHA-256 hashes for audit.
- Always run `npm run verify:native` before native tests or packaging.
- Treat `npm run smoke:package` output as non-release test evidence.
- Keep normal bundle artifacts under `src-tauri/target/release-artifacts/`,
  separate from Vite's root `dist/` output and isolated smoke builds.
- Treat the current ad-hoc macOS and unsigned Windows bundles as unverified,
  non-release distributions; never advise disabling Gatekeeper or SmartScreen.
- A production release must be properly signed/notarized and must publish the
  verified FFmpeg/x264 corresponding-source package in a durable location.

## Change discipline

- Prefer small targeted changes and tests alongside changed behavior.
- Preserve unrelated worktree changes and stage explicit paths only.
- Do not commit generated native binaries, build output, editor state, or
  local agent files.
