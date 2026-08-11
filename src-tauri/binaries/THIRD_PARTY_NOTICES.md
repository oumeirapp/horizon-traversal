# Native media third-party notices

The Horizon Traversal application launches FFmpeg and FFprobe as separate bundled
programs. The native programs described here are not linked into the Rust or
React application.

## FFmpeg

- Project: FFmpeg
- Version: 8.1.2
- Copyright: Copyright (c) 2000-2026 the FFmpeg developers
- Source: <https://ffmpeg.org/releases/ffmpeg-8.1.2.tar.xz>
- SHA-256: `464beb5e7bf0c311e68b45ae2f04e9cc2af88851abb4082231742a74d97b524c`
- License for this configuration: GNU GPL version 2 or later
- Project license information: <https://ffmpeg.org/legal.html>

The packaged tools are built with `--enable-gpl --enable-libx264`. FFmpeg is
provided without warranty, as stated in the GNU General Public License.

This software is based in part on the work of the Independent JPEG Group.
The bundled sources are unmodified; the exact build configuration is recorded
by the executable's `-version` output and by the build script.

## x264

- Project: x264
- Revision: `b35605ace3ddf7c1a5d67a2eb553f034aef41d55`
- Copyright: Copyright (C) 2003-2025 x264 project
- Source: <https://code.videolan.org/videolan/x264/-/archive/b35605ace3ddf7c1a5d67a2eb553f034aef41d55/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar.bz2>
- SHA-256: `6eeb82934e69fd51e043bd8c5b0d152839638d1ce7aa4eea65a3fedcf83ff224`
- License: GNU GPL version 2 or later
- Project: <https://www.videolan.org/developers/x264.html>

x264 is statically linked into the packaged FFmpeg and FFprobe executables. It
is provided without warranty, as stated in the GNU General Public License.

## Windows build runtime notices

The Windows x64 tools are built with the pinned LLVM-MinGW UCRT 20260616
toolchain. Exact, unmodified license files from the checksum-verified upstream
archive are bundled under `licenses/windows/`:

- `llvm-mingw/LICENSE.TXT` contains the LLVM Apache License 2.0 with LLVM
  Exceptions and the legacy LLVM license.
- `mingw-w64/COPYING.MinGW-w64-runtime.txt` contains the notices applicable to
  binaries statically linked with the MinGW-w64 runtime.
- `mingw-w64/COPYING`, `COPYING.MinGW-w64.txt`,
  `COPYING.winstorecompat.txt`, and `COPYING.winpthreads.txt` preserve the
  remaining x86_64 MinGW-w64 notices shipped by that toolchain.

Source archive: <https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip>

SHA-256: `b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35`

## Complete corresponding source

The two checksum-pinned archives above are distributed in
`Horizon-Traversal-native-source.zip`. The archive also contains:

- `scripts/build-native-macos-arm64.sh`
- `scripts/build-native-windows-x64.ps1`
- `scripts/prepare-ffmpeg.mjs`
- `src-tauri/native-assets.json`
- the package manifests required by the Node dispatcher
- this notice and `licenses/GPL-2.0-or-later.txt`

Together these are the source and build instructions for the unmodified native
programs distributed for Apple Silicon macOS and Windows x64. The native asset
manifest records the exact target toolchains, build options, and system
dependency allowlists. Source, toolchain-input, PDFium, and distribution-file
hashes remain pinned. Generated FFmpeg and FFprobe executables are temporarily
not byte-pinned; their versions, configuration, codecs, and dynamic dependencies
are semantically verified, and their actual SHA-256 hashes are reported for
audit. `SHA256SUMS` covers every file in the source offer, and
`npm run verify:source-offer` checks both the directory and the deterministic
ZIP against the repository and source pins.

Release publishers must make this verified archive available alongside every
binary release for as long as that release is distributed. Do not rely solely
on upstream availability: mirror the verified archive in the release's durable
source-download location.

If a release publisher uses a written source offer instead of accompanying
source, the offer and source availability must satisfy GPL section 3 and be
maintained for the required period. Release publishers are responsible for
reviewing the obligations that apply to their distribution method.

The applicable license text is included as `licenses/GPL-2.0-or-later.txt`.
