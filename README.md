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
npm run tauri dev
```

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
