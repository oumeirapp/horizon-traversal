# X Traversal

X Traversal collects approved assets from ticket folders and optimizes PDFs,
images, and videos for delivery.

The application is being migrated from Python/Tkinter to Tauri v2 with a
React/TypeScript frontend and Rust processing backend. During the migration,
the root contains the Tauri application and [`python/`](python/) contains the
working Python fallback.

## Tauri development

```bash
npm install
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run tauri dev
```

`prepare:pdfium` downloads the pinned PDFium 151.0.7920.0 Apple Silicon
library, verifies its checksums, and installs it into the Tauri bundle inputs.
The current macOS bundle requires macOS 12 or newer.

`prepare:ffmpeg` builds checksum-pinned FFmpeg 8.1.2 and x264 sources into
standalone Apple Silicon sidecars. It can take several minutes on a clean
machine. See [`src-tauri/binaries/README.md`](src-tauri/binaries/README.md) for
build requirements and release licensing obligations.

Build and test the frontend and Rust shell:

```bash
npm test
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

## Python fallback

```bash
cd python
uv sync --system-certs
uv run app.py
```

The Python fallback remains the behavioral reference until the final migration
stage.
