from __future__ import annotations

import hashlib
import io
import json
import re
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps, UnidentifiedImageError

from .models import (
    AssetInput,
    BuildManifest,
    PreparedAsset,
    Section,
    SlideSpec,
    TicketInput,
)


EXIF_ORIENTATION = 274
VIDEO_EXTENSIONS = {"mp4", "avi"}
SHA256_PATTERN = re.compile(r"[0-9a-fA-F]{64}")


class ManifestError(ValueError):
    """Raised when a manifest does not match protocol schema version 1."""


class AssetError(ValueError):
    """Raised when a selected media file cannot be safely embedded."""


def _object(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ManifestError(f"{location} must be an object")
    return value


def _array(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list):
        raise ManifestError(f"{location} must be an array")
    return value


def _string(value: Any, location: str, *, empty: bool = False) -> str:
    if not isinstance(value, str) or (not empty and not value.strip()):
        qualifier = "a string" if empty else "a non-empty string"
        raise ManifestError(f"{location} must be {qualifier}")
    return value if empty else value.strip()


def _integer(value: Any, location: str, *, minimum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ManifestError(f"{location} must be an integer")
    if minimum is not None and value < minimum:
        raise ManifestError(f"{location} must be at least {minimum}")
    return value


def _path(value: Any, location: str, base: Path) -> Path:
    raw = _string(value, location)
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.absolute()


def _optional_string(value: Any, location: str) -> str | None:
    if value is None:
        return None
    text = _string(value, location)
    return text


def _asset(value: Any, location: str, base: Path, asset_id: str) -> AssetInput:
    data = _object(value, location)
    kind = _string(data.get("kind"), f"{location}.kind")
    if kind not in {"image", "video"}:
        raise ManifestError(f"{location}.kind must be 'image' or 'video'")
    path = _path(data.get("path"), f"{location}.path", base)
    priority = _integer(data.get("priority"), f"{location}.priority")
    if kind == "image":
        return AssetInput(asset_id=asset_id, kind="image", path=path, priority=priority)

    poster_path = _path(data.get("posterPath"), f"{location}.posterPath", base)
    width_px = _integer(data.get("widthPx"), f"{location}.widthPx", minimum=1)
    height_px = _integer(data.get("heightPx"), f"{location}.heightPx", minimum=1)
    duration_ms = _integer(data.get("durationMs"), f"{location}.durationMs", minimum=0)
    extension = _string(data.get("extension"), f"{location}.extension").lstrip(".").casefold()
    if extension not in VIDEO_EXTENSIONS:
        raise ManifestError(f"{location}.extension must be mp4 or avi")
    compatibility = _string(data.get("compatibility"), f"{location}.compatibility")
    sha256 = _string(data.get("sha256"), f"{location}.sha256").casefold()
    if not SHA256_PATTERN.fullmatch(sha256):
        raise ManifestError(f"{location}.sha256 must be 64 hexadecimal characters")
    raw_warnings = _array(data.get("warnings"), f"{location}.warnings")
    warnings = tuple(
        _string(item, f"{location}.warnings[{index}]")
        for index, item in enumerate(raw_warnings)
    )
    return AssetInput(
        asset_id=asset_id,
        kind="video",
        path=path,
        priority=priority,
        poster_path=poster_path,
        width_px=width_px,
        height_px=height_px,
        duration_ms=duration_ms,
        extension=extension,
        compatibility=compatibility,
        sha256=sha256,
        warnings=warnings,
    )


def load_manifest(path: Path | str) -> BuildManifest:
    source = Path(path).expanduser().absolute()
    try:
        raw = json.loads(source.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ManifestError(f"Cannot read manifest {source}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ManifestError(
            f"Manifest {source} is not valid JSON at line {exc.lineno}, column {exc.colno}"
        ) from exc
    data = _object(raw, "manifest")
    version = _integer(data.get("schemaVersion"), "manifest.schemaVersion")
    if version != 1:
        raise ManifestError(f"Unsupported manifest schemaVersion {version}; expected 1")
    base = source.parent
    template = _path(data.get("template"), "manifest.template", base)
    output = _path(data.get("output"), "manifest.output", base)
    report = _path(data.get("report"), "manifest.report", base)
    cancel_path = _path(data.get("cancelPath"), "manifest.cancelPath", base)
    if template == output:
        raise ManifestError("manifest.output must not overwrite manifest.template")
    raw_tickets = _array(data.get("tickets"), "manifest.tickets")
    tickets: list[TicketInput] = []
    names: set[str] = set()
    for ticket_index, raw_ticket in enumerate(raw_tickets):
        location = f"manifest.tickets[{ticket_index}]"
        ticket = _object(raw_ticket, location)
        name = _string(ticket.get("name"), f"{location}.name")
        title = _string(ticket.get("title"), f"{location}.title")
        if name in names:
            raise ManifestError(f"Duplicate ticket name: {name}")
        names.add(name)
        blank_reason = _optional_string(ticket.get("blankReason"), f"{location}.blankReason")
        raw_master = _array(ticket.get("master"), f"{location}.master")
        raw_deliverables = _array(ticket.get("deliverables"), f"{location}.deliverables")
        raw_ticket_warnings = ticket.get("warnings", [])
        ticket_warnings = tuple(
            _string(item, f"{location}.warnings[{index}]")
            for index, item in enumerate(
                _array(raw_ticket_warnings, f"{location}.warnings")
            )
        )
        if len(raw_master) > 2:
            raise ManifestError(f"{location}.master contains more than the selected limit of 2")
        if len(raw_deliverables) > 6:
            raise ManifestError(
                f"{location}.deliverables contains more than the selected limit of 6"
            )
        master = tuple(
            _asset(item, f"{location}.master[{index}]", base, f"{ticket_index}:master:{index}")
            for index, item in enumerate(raw_master)
        )
        if any(asset.kind != "image" for asset in master):
            raise ManifestError(f"{location}.master accepts image assets only")
        deliverables = tuple(
            _asset(
                item,
                f"{location}.deliverables[{index}]",
                base,
                f"{ticket_index}:deliverables:{index}",
            )
            for index, item in enumerate(raw_deliverables)
        )
        tickets.append(
            TicketInput(
                name=name,
                title=title,
                blank_reason=blank_reason,
                master=master,
                deliverables=deliverables,
                warnings=ticket_warnings,
            )
        )
    return BuildManifest(
        source=source,
        template=template,
        output=output,
        report=report,
        cancel_path=cancel_path,
        tickets=tuple(tickets),
    )


def _read_regular_file(path: Path, label: str) -> bytes:
    if path.is_symlink():
        raise AssetError(f"{label} is a symbolic link")
    if not path.is_file():
        raise AssetError(f"{label} does not exist or is not a regular file")
    try:
        return path.read_bytes()
    except OSError as exc:
        raise AssetError(f"cannot read {label}: {exc}") from exc


def _png_has_transparency(image: Image.Image) -> bool:
    if image.mode in {"RGBA", "LA"}:
        minimum, _maximum = image.getchannel("A").getextrema()
        return minimum < 255
    if image.mode == "P" and "transparency" in image.info:
        transparency = image.info["transparency"]
        return isinstance(transparency, int) or (
            isinstance(transparency, bytes) and any(alpha < 255 for alpha in transparency)
        )
    return False


def _decode_image(path: Path) -> tuple[int, int, bool, bool, bytes, str]:
    original = _read_regular_file(path, f"image {path}")
    try:
        with Image.open(io.BytesIO(original)) as opened:
            opened.load()
            image_format = (opened.format or "").upper()
            orientation = opened.getexif().get(EXIF_ORIENTATION, 1)
            image = ImageOps.exif_transpose(opened)
            animated = bool(
                image_format == "GIF"
                and getattr(opened, "is_animated", False)
                and getattr(opened, "n_frames", 1) > 1
            )
            if image_format == "GIF":
                return opened.width, opened.height, "transparency" in opened.info, animated, original, "gif"
            if image_format == "JPEG":
                if orientation == 1 and image.mode == "RGB":
                    return image.width, image.height, False, False, original, "jpeg"
                buffer = io.BytesIO()
                image.convert("RGB").save(buffer, format="JPEG", quality=95)
                return image.width, image.height, False, False, buffer.getvalue(), "jpeg"
            if image_format == "PNG" and orientation == 1:
                return (
                    image.width,
                    image.height,
                    _png_has_transparency(image),
                    False,
                    original,
                    "png",
                )
            buffer = io.BytesIO()
            image.convert("RGBA" if _png_has_transparency(image) else "RGB").save(
                buffer, format="PNG"
            )
            return (
                image.width,
                image.height,
                _png_has_transparency(image),
                False,
                buffer.getvalue(),
                "png",
            )
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise AssetError(f"cannot decode image {path}: {exc}") from exc


def _video_poster(path: Path, width_px: int, height_px: int) -> bytes:
    original = _read_regular_file(path, f"video poster {path}")
    try:
        with Image.open(io.BytesIO(original)) as opened:
            opened.load()
            poster = ImageOps.exif_transpose(opened).convert("RGB")
            scale = min(1.0, 1920 / max(width_px, height_px))
            canvas_size = (
                max(1, round(width_px * scale)),
                max(1, round(height_px * scale)),
            )
            contained = ImageOps.contain(poster, canvas_size, Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", canvas_size, "black")
            canvas.paste(
                contained,
                ((canvas.width - contained.width) // 2, (canvas.height - contained.height) // 2),
            )
            buffer = io.BytesIO()
            canvas.save(buffer, format="PNG", optimize=False)
            return buffer.getvalue()
    except (OSError, ValueError, UnidentifiedImageError) as exc:
        raise AssetError(f"cannot decode video poster {path}: {exc}") from exc


def prepare_asset(asset: AssetInput, section: Section) -> PreparedAsset:
    if asset.kind == "image":
        width, height, transparent, animated, data, extension = _decode_image(asset.path)
        return PreparedAsset(
            asset_id=asset.asset_id,
            kind="image",
            path=asset.path,
            section=section,
            width_px=width,
            height_px=height,
            priority=asset.priority,
            display_bytes=data,
            display_extension=extension,
            has_transparency=transparent,
            is_animated=animated,
            actual_sha256=hashlib.sha256(_read_regular_file(asset.path, f"image {asset.path}")).hexdigest(),
        )

    assert asset.poster_path is not None
    assert asset.width_px is not None and asset.height_px is not None
    assert asset.extension is not None and asset.sha256 is not None
    video = _read_regular_file(asset.path, f"video {asset.path}")
    actual_sha256 = hashlib.sha256(video).hexdigest()
    if actual_sha256 != asset.sha256:
        raise AssetError(
            f"video SHA-256 mismatch for {asset.path}: expected {asset.sha256}, got {actual_sha256}"
        )
    path_extension = asset.path.suffix.lstrip(".").casefold()
    if path_extension and path_extension != asset.extension:
        raise AssetError(
            f"video extension mismatch for {asset.path}: manifest says .{asset.extension}"
        )
    poster = _video_poster(asset.poster_path, asset.width_px, asset.height_px)
    return PreparedAsset(
        asset_id=asset.asset_id,
        kind="video",
        path=asset.path,
        section=section,
        width_px=asset.width_px,
        height_px=asset.height_px,
        priority=asset.priority,
        display_bytes=poster,
        display_extension="png",
        poster_path=asset.poster_path,
        video_bytes=video,
        video_extension=asset.extension,
        duration_ms=asset.duration_ms,
        compatibility=asset.compatibility,
        declared_sha256=asset.sha256,
        actual_sha256=actual_sha256,
        warnings=asset.warnings,
    )


def prepare_ticket(ticket: TicketInput, check_cancel) -> SlideSpec:
    if ticket.blank_reason is not None:
        return SlideSpec(
            name=ticket.name,
            title=ticket.name,
            master=[],
            deliverables=[],
            selected_master=ticket.master,
            selected_deliverables=ticket.deliverables,
            blank_reason=ticket.blank_reason,
            warnings=list(ticket.warnings),
        )
    prepared_master: list[PreparedAsset] = []
    prepared_deliverables: list[PreparedAsset] = []
    errors: list[str] = []
    for section, inputs, destination in (
        ("master", ticket.master, prepared_master),
        ("deliverables", ticket.deliverables, prepared_deliverables),
    ):
        for asset in inputs:
            check_cancel()
            try:
                destination.append(prepare_asset(asset, section))
            except AssetError as exc:
                errors.append(str(exc))
            check_cancel()
    if errors:
        return SlideSpec(
            name=ticket.name,
            title=ticket.name,
            master=[],
            deliverables=[],
            selected_master=ticket.master,
            selected_deliverables=ticket.deliverables,
            blank_reason="Corrupt selected asset: " + "; ".join(errors),
            warnings=[*ticket.warnings, *errors],
        )
    if not prepared_master and not prepared_deliverables:
        return SlideSpec(
            name=ticket.name,
            title=ticket.name,
            master=[],
            deliverables=[],
            selected_master=ticket.master,
            selected_deliverables=ticket.deliverables,
            blank_reason="No selected media.",
            warnings=list(ticket.warnings),
        )
    return SlideSpec(
        name=ticket.name,
        title=ticket.title,
        master=prepared_master,
        deliverables=prepared_deliverables,
        selected_master=ticket.master,
        selected_deliverables=ticket.deliverables,
        warnings=[
            *ticket.warnings,
            *[
                warning
                for asset in [*prepared_master, *prepared_deliverables]
                for warning in asset.warnings
            ],
        ],
    )
