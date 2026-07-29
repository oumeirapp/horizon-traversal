# X Traversal

X Traversal collects approved assets from ticket folders and optimizes PDFs,
images, and videos for delivery.

The application is being migrated from Python/Tkinter to Tauri v2 with a
React/TypeScript frontend and Rust processing backend. During the migration,
the root contains the Tauri application and [`python/`](python/) contains the
working Python fallback.

## Tauri development

```bash
npm ci
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run verify:native
npm run tauri dev
```

`prepare:pdfium` downloads the pinned PDFium 151.0.7920.0 Apple Silicon
library, verifies its checksums, and installs it into the Tauri bundle inputs.
The current macOS bundle requires macOS 12 or newer.

`prepare:ffmpeg` builds checksum-pinned FFmpeg 8.1.2 and x264 sources into
standalone Apple Silicon sidecars. It can take several minutes on a clean
machine. See [`src-tauri/binaries/README.md`](src-tauri/binaries/README.md) for
build requirements and release licensing obligations.

The reproducible Apple Silicon release inputs are pinned in
[`src-tauri/native-assets.json`](src-tauri/native-assets.json). Native FFmpeg
builds require macOS 26, Command Line Tools 26.6, the macOS 26.5 SDK, and the
exact Apple Clang build recorded there. The preparation script stops before
publishing artifacts if the toolchain or output checksums differ.

Build and test the frontend and Rust shell:

```bash
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

## Parity and packaging checks

On Apple Silicon macOS, the opt-in parity suite runs the Python reference and
the Rust coordinator over the same generated ticket tree:

```bash
npm run test:parity
```

The packaged smoke command builds an unsigned, test-enabled `.app`, verifies
all copied native assets before signing, applies a local ad-hoc signature,
verifies the signed bundle, and processes a PDF, oversized PNG, and portrait
video with audio:

```bash
npm run smoke:package
```

This is backend and bundle evidence, not a distributable release signature,
notarization, Gatekeeper, or native-dialog test. The generated smoke app is
explicitly non-release software because it contains the opt-in smoke harness.

FFmpeg and x264 are GPL-covered in this build. Prepare the complete
corresponding-source package for every distributed release with:

```bash
npm run prepare:source-offer
(cd dist/native-source-offer && shasum -a 256 -c SHA256SUMS)
```

Publish that source package in the same durable release location as the app.
Temporary CI artifacts do not satisfy the long-term source-availability
obligation. PDFium notices and its complete pinned wheel license set are
bundled under `src-tauri/resources/licenses/pdfium/`.

CI keeps frontend checks platform-neutral and runs native/parity checks on the
pinned macOS 26 Apple Silicon image. The full package smoke is a manual,
target-specific job.

## Python fallback

```bash
cd python
uv sync --system-certs
uv run --locked --system-certs app.py
```

The Python fallback remains the behavioral reference until the final migration
stage.
