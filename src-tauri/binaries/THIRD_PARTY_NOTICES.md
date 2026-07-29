# Native media third-party notices

The X Traversal application launches FFmpeg and FFprobe as separate bundled
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

## Complete corresponding source

The two checksum-pinned archives above, together with
`scripts/build-native-macos-arm64.sh`, are the complete source and build
instructions for the unmodified native programs distributed by this project.
Release publishers must make those exact archives and the build script
available alongside each binary release for as long as that release is
distributed. Do not rely solely on upstream availability: mirror the verified
archives in the release's durable source-download location.

If a release publisher uses a written source offer instead of accompanying
source, the offer and source availability must satisfy GPL section 3 and be
maintained for the required period. Release publishers are responsible for
reviewing the obligations that apply to their distribution method.

The applicable license text is included as `licenses/GPL-2.0-or-later.txt`.
