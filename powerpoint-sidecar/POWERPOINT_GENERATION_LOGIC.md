# PowerPoint sidecar generation logic

## Contract boundary

The sidecar accepts one operation: `horizon-pptx build-manifest MANIFEST`.
`schemaVersion` must be `1`. The manifest is authoritative: it supplies ticket
order, title, selected Master and Deliverables media, output paths, template, and
cancellation sentinel. The sidecar does not traverse ticket folders or make a
second selection decision.

The reusable template/package and deterministic layout logic was migrated from
the standalone prototype. The prototype remains independent and unchanged.

## Build sequence

```text
parse and structurally validate manifest
check cancelPath

for each ticket in manifest order:
    emit progress(layout)
    if blankReason exists:
        retain a blank content-slide specification titled with the ticket name
        continue

    for each already-selected asset:
        check cancelPath
        decode image or poster
        for video, read raw bytes and verify SHA-256
        check cancelPath

    if any selected asset failed:
        discard all prepared media for this ticket
        retain a ticket-named blank slide with a corruption blankReason
    else if no media exists:
        retain a blank slide with "No selected media."
    else:
        compute deterministic, contain-only placements

load and CRC-check the two-slide template
clone template slide 2 once per additional ticket
register each slide relationship, slide ID, and content type
deduplicate prepared poster/image bytes and raw video bytes by SHA-256

for each ticket in manifest order:
    emit progress(compose)
    copy the untouched base slide XML and relationships
    replace the title placeholder text
    for a nonblank slide, append image/video pictures and relationships
    for a video slide, append click-to-play timing

verify the intro-slide hashes did not change
emit progress(save)
write a temporary deterministic ZIP, checking cancellation between members
atomically replace the PPTX destination
atomically write the JSON report
emit completed(summary)
```

Cancellation raises a dedicated internal exception. The temporary PPTX is
removed, a `cancelled` protocol event is emitted, and the process exits `3`.

## Image validation and no-crop rule

Pillow fully loads every image so truncated or mislabeled inputs fail before
composition. JPEG EXIF orientation is applied when needed. PNG transparency and
animated GIF bytes are retained. Other Pillow-decodable still formats are
normalized to PNG.

Video posters are decoded and contained on a black canvas matching the video
metadata aspect ratio. The poster is never cropped. Layout placement uses that
same `widthPx / heightPx` ratio, so video playback is not stretched relative to
its declared geometry.

Within each section, the layout engine evaluates deterministic row shelves,
column shelves, and contained grids. A candidate's score rewards readable area,
priority, density, and centering. Ties use a stable layout identifier. Every
rectangle stays within the fixed content band, preserves source aspect ratio,
and does not overlap another rectangle. Master and Deliverables remain separated
by the fixed section gap.

## Raw video OOXML

The source MP4 or AVI is read once, SHA-256 verified, and written byte-for-byte
to `ppt/media/mediaN.<extension>`. The package adds a default content type of
`video/mp4` or `video/avi`.

Each video poster is a normal `p:pic`. Its nonvisual properties contain:

```xml
<a:hlinkClick r:id="" action="ppaction://media"/>
<a:videoFile r:link="rIdVideo"/>
<p:extLst>
  <p:ext uri="{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}">
    <p14:media r:embed="rIdMedia"/>
  </p:ext>
</p:extLst>
```

The slide relationship part points `rIdVideo` at the raw media with the Office
video relationship type and `rIdMedia` at the same bytes with the Microsoft
media relationship type. The poster uses a third image relationship.

The slide timing tree assigns unique timing-node IDs, a click-effect
`playFrom(0.0)` command with the manifest duration, a media node targeting the
video picture's unique shape ID, and an interactive `togglePause` sequence. This
matches PowerPoint's embedded-media model and keeps click-to-play behavior.

## Report guarantees

The JSON report is schema version 1 and includes:

- intro preservation hashes and aggregate counts;
- a slide row for every manifest ticket, including blank tickets;
- `blankReason`, selected Master/Deliverables names, layout and placement data;
- each media path, kind, priority, compatibility, warnings, declared SHA-256,
  actual SHA-256, and embedded poster/video part names;
- effective DPI warnings and source geometry.

Raw video hashes in the report refer to exactly the bytes stored in the package.
