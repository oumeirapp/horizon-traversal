# Python/Rust semantic parity harness

This opt-in harness runs the frozen Python reference and the Rust coordinator
against the same generated ticket tree. It is intentionally excluded from the
normal Rust test run because it requires macOS arm64, the Python environment,
PDFium, and the prepared FFmpeg/FFprobe executables.

Prepare the native assets, then run:

```bash
npm run prepare:pdfium
npm run prepare:ffmpeg
sh scripts/parity/run-macos-arm64.sh
```

If `uv` is not on `PATH`, set `X_TRAVERSAL_UV` to its absolute executable
path.

The harness forces Python to resolve `ffmpeg` and `ffprobe` through temporary
unsuffixed links to the exact executables used by the Rust media runner. It
verifies every prepared native asset against `native-assets.json` before the
test starts. It compares ticket selection, version choice, collision suffixes,
PDFs, image and video dimensions, audio preservation, reports, error
continuation, and log classification.

Only the migration's approved behavior corrections may differ:

- Rust rejects a trailing empty filter token that Python accepted.
- Rust reports contain only the current ticket's source paths.
- Rust skips symlinks instead of following them.
- Rust uses deterministic traversal and collision ordering.
- Rust preserves ultra-wide video aspect ratio instead of stretching it.
- Rust reports partial and failed outcomes instead of always announcing
  success.
