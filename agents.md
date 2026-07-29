# AGENTS.md

# X Traversal

X Traversal is a local desktop application for collecting approved assets from
ticket folders. The repository is migrating from Python/Tkinter to Tauri v2.

## Transitional structure

- `src/`: React and TypeScript presentation code.
- `src-tauri/`: Rust processing and Tauri desktop integration.
- `python/`: working Python fallback and behavioral reference until cutover.

UI code belongs in `src/`. Filesystem traversal and media processing belong in
Rust under `src-tauri/src/`. Do not access the filesystem or spawn programs from
the React webview.

## Package management

Use npm for the Tauri frontend and Cargo for Rust:

```bash
npm ci
npm run prepare:pdfium
npm run prepare:ffmpeg
npm run verify:native
npm run tauri dev
npm test
cargo test --locked --manifest-path src-tauri/Cargo.toml --all-features
cargo clippy --locked --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

The fallback remains an uv project. Always include `--system-certs` for uv
dependency operations:

```bash
cd python
uv sync --system-certs
uv run --locked --system-certs app.py
```

Do not use pip, Poetry, pnpm, or Yarn.

## Architecture rules

- Preserve the deterministic stage order: discover, copy, PDF, images, video,
  report.
- Keep the ticket output structure flat and isolated per ticket.
- Keep functions focused and avoid framework-like abstractions.
- Preserve cross-platform behavior and Tauri packaging compatibility.
- Register every Tauri command and grant only the capability it needs.
- Keep `src-tauri/src/main.rs` as a thin call into `lib.rs`.
- Do not expose shell, opener, or filesystem plugins directly to the webview.
- Keep native source versions, toolchain identity, output hashes, licenses, and
  bundle declarations synchronized through `src-tauri/native-assets.json` and
  `npm run verify:native`.

## Change discipline

- Prefer small targeted changes and tests alongside each ported behavior.
- Keep the Python fallback working until packaged parity is verified.
- Do not commit generated native binaries or unrelated local workspace files.
- Treat `npm run smoke:package` output as local smoke evidence, never as a
  signed or notarized production release.
