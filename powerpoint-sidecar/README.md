# Horizon PowerPoint sidecar

This directory contains the isolated Python sidecar used by Horizon Traversal to
turn a native, schema-versioned manifest into a template-based PowerPoint deck.
The React webview never reads files or launches this process; the Rust host owns
manifest creation, process control, and cancellation.

The bundled template is `resources/Slide template.pptx`. Its SHA-256 is
`b1cb647f4856619b2a5447b95a1505fea77ab599925cf51bb0044b844592a366`.

## Development

```bash
python -m venv .venv
.venv/bin/pip install -e '.[dev]'
.venv/bin/pytest
.venv/bin/horizon-pptx --version
.venv/bin/horizon-pptx build-manifest /absolute/path/to/manifest.json
```

The command writes only JSON objects, one per stdout line, while a manifest build
is running. Human-readable errors also go to stderr. Exit code `0` means success,
`2` means invalid input/build failure, and `3` means cancellation.

## Manifest schema version 1

Paths may be absolute or relative to the manifest file. Ticket order and asset
order are preserved.

```json
{
  "schemaVersion": 1,
  "template": "resources/Slide template.pptx",
  "output": "/tmp/horizon/output.pptx",
  "report": "/tmp/horizon/output.report.json",
  "cancelPath": "/tmp/horizon/cancel.request",
  "tickets": [
    {
      "name": "P12345",
      "title": "P12345 - Campaign title",
      "master": [
        {"kind": "image", "path": "/approved/master.png", "priority": 5}
      ],
      "deliverables": [
        {
          "kind": "video",
          "path": "/approved/deliverable.mp4",
          "posterPath": "/approved/deliverable-poster.png",
          "priority": 4,
          "widthPx": 1920,
          "heightPx": 1080,
          "durationMs": 30000,
          "extension": "mp4",
          "compatibility": "powerpoint-native",
          "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "warnings": []
        }
      ]
    },
    {
      "name": "P12346",
      "title": "P12346 - No approved media",
      "blankReason": "No approved media was selected.",
      "master": [],
      "deliverables": []
    }
  ]
}
```

Rust has already selected at most two `master` and six `deliverables` entries.
The sidecar enforces those bounds but does not rescan, sort, select, or transcode
source video. Images and video posters are decoded with Pillow. If any selected
asset for a ticket is missing, corrupt, unsafe, or has a video hash mismatch, the
entire ticket becomes a base-template slide titled with its ticket folder name
and no media. Other
tickets continue. Explicit `blankReason` tickets also always receive a slide.

MP4 and AVI bytes are embedded unchanged. Each video uses a decoded, contained
poster, both required OOXML media relationships, and click-to-play timing. The
JSON report records each ticket's `blankReason`, video compatibility, warnings,
declared and actual hashes, embedded part names, and deterministic placements.

## JSONL protocol

Every build event has `"protocol": 1` and an `event` discriminator:

- `log`: `level`, optional `ticket`, and `message`.
- `progress`: `step` (`layout`, `compose`, or `save`), `ticket`, `index`, `total`,
  and `message`.
- `completed`: a `summary` object with output/report paths and build counts.
- `cancelled`: `message`; the process exits with code `3`.

The sidecar checks `cancelPath` before and after asset, ticket, composition, and
ZIP-member operations. A cancelled package is never moved over the destination.

## Frozen executable

Install the bundle extra, then build with the checked-in specification:

```bash
.venv/bin/pip install -e '.[bundle]'
.venv/bin/pyinstaller --clean --noconfirm horizon-pptx.spec
```

The specification produces the Tauri external binary `powerpoint-sidecar`.
Tauri bundles the exact template separately at
`powerpoint/Slide template.pptx`, and Rust passes that verified path through the
manifest. The exact dependency inventory, third-party notice, and deterministic
license tree are bundled beside it under `powerpoint/`; the license tree
includes Pillow's native image-library notices. Preparation also executes a
real blank-slide `build-manifest` smoke using the frozen executable and verified
template. The installed development CLI remains `horizon-pptx`.

The frozen-build requirements pin the exact macOS arm64 and Windows x64 wheel
hashes. Preparation requires those hashes and binary-only artifacts before it
will build the sidecar.

See [POWERPOINT_GENERATION_LOGIC.md](POWERPOINT_GENERATION_LOGIC.md) for package
and layout details and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for
dependency notices.
