from __future__ import annotations

import hashlib
import os
import re
import tempfile
import zipfile
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

from defusedxml import minidom

from .layout import MIN_EFFECTIVE_DPI
from .models import AssetInput, LayoutResult, Placement, PreparedAsset, SlideSpec


EMU_PER_INCH = 914_400
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SLIDE_REL_TYPE = f"{REL_NS}/slide"
IMAGE_REL_TYPE = f"{REL_NS}/image"
VIDEO_REL_TYPE = f"{REL_NS}/video"
MEDIA_REL_TYPE = "http://schemas.microsoft.com/office/2007/relationships/media"
SLIDE_CONTENT_TYPE = (
    "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"
)
CONTENT_TYPES = {
    "jpeg": "image/jpeg",
    "jpg": "image/jpeg",
    "png": "image/png",
    "gif": "image/gif",
    "mp4": "video/mp4",
    "avi": "video/avi",
}
FIXED_ZIP_TIME = (1980, 1, 1, 0, 0, 0)


class BuildError(RuntimeError):
    """Raised when the template cannot be safely populated."""


@dataclass(frozen=True)
class MediaParts:
    poster: str
    video: str | None = None


def _parse_xml(data: bytes, part_name: str):
    try:
        return minidom.parseString(data)
    except Exception as exc:  # defusedxml exception classes vary by Python version
        raise BuildError(f"Cannot parse {part_name}: {exc}") from exc


def _serialize_xml(document) -> bytes:
    return document.toxml(encoding="UTF-8", standalone=True)


def _text(element) -> str:
    return "".join(
        child.data
        for child in element.childNodes
        if child.nodeType in {child.TEXT_NODE, child.CDATA_SECTION_NODE}
    )


def _set_text(element, value: str) -> None:
    for child in list(element.childNodes):
        if child.nodeType in {child.TEXT_NODE, child.CDATA_SECTION_NODE}:
            child.data = value
            return
    element.appendChild(element.ownerDocument.createTextNode(value))


def _direct_elements(parent, tag_name: str | None = None):
    return [
        child
        for child in parent.childNodes
        if child.nodeType == child.ELEMENT_NODE
        and (tag_name is None or child.tagName == tag_name)
    ]


def _append(document, parent, name: str, attributes: dict[str, object] | None = None):
    element = document.createElement(name)
    for key, value in (attributes or {}).items():
        element.setAttribute(key, str(value))
    parent.appendChild(element)
    return element


def _emu(value: float) -> str:
    return str(int(round(value * EMU_PER_INCH)))


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _member_hash(parts: dict[str, bytes], name: str) -> str | None:
    data = parts.get(name)
    return _sha256(data) if data is not None else None


def _load_template(
    template: Path,
) -> tuple[dict[str, bytes], dict[str, zipfile.ZipInfo], list[str]]:
    if not template.is_file():
        raise BuildError(f"Template does not exist: {template}")
    try:
        with zipfile.ZipFile(template) as archive:
            bad_member = archive.testzip()
            if bad_member:
                raise BuildError(f"Template ZIP member failed CRC: {bad_member}")
            names = archive.namelist()
            parts = {name: archive.read(name) for name in names}
            infos = {info.filename: info for info in archive.infolist()}
    except zipfile.BadZipFile as exc:
        raise BuildError(f"Template is not a valid PPTX ZIP package: {template}") from exc
    required = {
        "[Content_Types].xml",
        "ppt/presentation.xml",
        "ppt/_rels/presentation.xml.rels",
        "ppt/slides/slide1.xml",
        "ppt/slides/slide2.xml",
        "ppt/slides/_rels/slide2.xml.rels",
    }
    missing = sorted(required - set(parts))
    if missing:
        raise BuildError(f"Template is missing required parts: {', '.join(missing)}")
    slide_parts = sorted(
        name for name in parts if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)
    )
    if slide_parts != ["ppt/slides/slide1.xml", "ppt/slides/slide2.xml"]:
        raise BuildError("Template must contain exactly slide1.xml and slide2.xml")
    return parts, infos, names


def _next_rid(elements: Iterable) -> int:
    values: list[int] = []
    for element in elements:
        match = re.fullmatch(r"rId(\d+)", element.getAttribute("Id"))
        if match:
            values.append(int(match.group(1)))
    return max(values, default=0) + 1


def _register_slides(parts: dict[str, bytes], slide_count: int) -> None:
    presentation_name = "ppt/presentation.xml"
    relationships_name = "ppt/_rels/presentation.xml.rels"
    content_types_name = "[Content_Types].xml"
    presentation = _parse_xml(parts[presentation_name], presentation_name)
    relationships = _parse_xml(parts[relationships_name], relationships_name)
    content_types = _parse_xml(parts[content_types_name], content_types_name)
    slide_lists = presentation.getElementsByTagName("p:sldIdLst")
    if len(slide_lists) != 1:
        raise BuildError("Template presentation.xml must have exactly one p:sldIdLst")
    slide_list = slide_lists[0]
    existing_slide_ids = [
        int(element.getAttribute("id"))
        for element in slide_list.getElementsByTagName("p:sldId")
        if element.hasAttribute("id")
    ]
    if len(existing_slide_ids) != 2:
        raise BuildError("Template presentation must list exactly two slides")
    next_slide_id = max(existing_slide_ids) + 1
    relationship_root = relationships.documentElement
    next_relationship_id = _next_rid(
        relationship_root.getElementsByTagName("Relationship")
    )
    for slide_number in range(3, slide_count + 1):
        relationship_id = f"rId{next_relationship_id}"
        next_relationship_id += 1
        _append(
            relationships,
            relationship_root,
            "Relationship",
            {
                "Id": relationship_id,
                "Type": SLIDE_REL_TYPE,
                "Target": f"slides/slide{slide_number}.xml",
            },
        )
        slide_id = _append(
            presentation,
            slide_list,
            "p:sldId",
            {"id": next_slide_id},
        )
        slide_id.setAttributeNS(REL_NS, "r:id", relationship_id)
        next_slide_id += 1
        _append(
            content_types,
            content_types.documentElement,
            "Override",
            {
                "PartName": f"/ppt/slides/slide{slide_number}.xml",
                "ContentType": SLIDE_CONTENT_TYPE,
            },
        )
    parts[presentation_name] = _serialize_xml(presentation)
    parts[relationships_name] = _serialize_xml(relationships)
    parts[content_types_name] = _serialize_xml(content_types)


def _ensure_content_type(parts: dict[str, bytes], extension: str) -> None:
    extension = extension.casefold()
    content_type = CONTENT_TYPES[extension]
    name = "[Content_Types].xml"
    document = _parse_xml(parts[name], name)
    root = document.documentElement
    for element in root.getElementsByTagName("Default"):
        if element.getAttribute("Extension").casefold() == extension:
            if element.getAttribute("ContentType") != content_type:
                raise BuildError(f"Conflicting content type for .{extension}")
            return
    default = document.createElement("Default")
    default.setAttribute("Extension", extension)
    default.setAttribute("ContentType", content_type)
    first_override = next(iter(root.getElementsByTagName("Override")), None)
    if first_override is None:
        root.appendChild(default)
    else:
        root.insertBefore(default, first_override)
    parts[name] = _serialize_xml(document)


def _update_title(document, title: str) -> None:
    for shape in document.getElementsByTagName("p:sp"):
        placeholders = shape.getElementsByTagName("p:ph")
        if not any(item.getAttribute("type") == "title" for item in placeholders):
            continue
        text_nodes = shape.getElementsByTagName("a:t")
        if not text_nodes:
            raise BuildError("Template title shape has no a:t node")
        _set_text(text_nodes[0], title)
        for extra in text_nodes[1:]:
            _set_text(extra, "")
        return
    raise BuildError("Template slide has no title placeholder")


def _move_label(document, label: str, center_x: float | None) -> None:
    if center_x is None:
        return
    for shape in document.getElementsByTagName("p:sp"):
        shape_text = "".join(_text(node) for node in shape.getElementsByTagName("a:t"))
        if shape_text.strip() != label:
            continue
        transforms = shape.getElementsByTagName("a:xfrm")
        if not transforms:
            raise BuildError(f"Template {label} label has no transform")
        offsets = transforms[0].getElementsByTagName("a:off")
        extents = transforms[0].getElementsByTagName("a:ext")
        if not offsets or not extents:
            raise BuildError(f"Template {label} label transform is incomplete")
        width = int(extents[0].getAttribute("cx")) / EMU_PER_INCH
        x = max(0.40, min(12.69 - width, center_x - width / 2))
        offsets[0].setAttribute("x", _emu(x))
        return
    raise BuildError(f"Template slide has no {label} label")


def _append_geometry(document, picture, placement: Placement) -> None:
    shape_properties = _append(document, picture, "p:spPr")
    transform = _append(document, shape_properties, "a:xfrm")
    _append(
        document,
        transform,
        "a:off",
        {"x": _emu(placement.rect.x), "y": _emu(placement.rect.y)},
    )
    _append(
        document,
        transform,
        "a:ext",
        {"cx": _emu(placement.rect.width), "cy": _emu(placement.rect.height)},
    )
    geometry = _append(document, shape_properties, "a:prstGeom", {"prst": "rect"})
    _append(document, geometry, "a:avLst")
    line = _append(document, shape_properties, "a:ln", {"w": "12700"})
    if placement.asset.has_transparency:
        _append(document, line, "a:noFill")
    else:
        fill = _append(document, line, "a:solidFill")
        _append(document, fill, "a:srgbClr", {"val": "E6E6E6"})


def _append_picture(
    document,
    tree,
    placement: Placement,
    shape_id: int,
    poster_relationship_id: str,
) -> None:
    picture = _append(document, tree, "p:pic")
    non_visual = _append(document, picture, "p:nvPicPr")
    _append(
        document,
        non_visual,
        "p:cNvPr",
        {
            "id": shape_id,
            "name": f"{placement.asset.section.capitalize()} - {placement.asset.path.name}",
            "descr": placement.asset.path.name,
        },
    )
    picture_properties = _append(document, non_visual, "p:cNvPicPr")
    _append(document, picture_properties, "a:picLocks", {"noChangeAspect": "1"})
    _append(document, non_visual, "p:nvPr")
    blip_fill = _append(document, picture, "p:blipFill")
    _append(document, blip_fill, "a:blip", {"r:embed": poster_relationship_id})
    stretch = _append(document, blip_fill, "a:stretch")
    _append(document, stretch, "a:fillRect")
    _append_geometry(document, picture, placement)


def _append_video_picture(
    document,
    tree,
    placement: Placement,
    shape_id: int,
    media_relationship_id: str,
    video_relationship_id: str,
    poster_relationship_id: str,
) -> None:
    picture = _append(document, tree, "p:pic")
    non_visual = _append(document, picture, "p:nvPicPr")
    properties = _append(
        document,
        non_visual,
        "p:cNvPr",
        {
            "id": shape_id,
            "name": f"Video - {placement.asset.path.name}",
            "descr": placement.asset.path.name,
        },
    )
    _append(
        document,
        properties,
        "a:hlinkClick",
        {"r:id": "", "action": "ppaction://media"},
    )
    picture_properties = _append(document, non_visual, "p:cNvPicPr")
    _append(document, picture_properties, "a:picLocks", {"noChangeAspect": "1"})
    non_visual_properties = _append(document, non_visual, "p:nvPr")
    _append(
        document,
        non_visual_properties,
        "a:videoFile",
        {"r:link": video_relationship_id},
    )
    extension_list = _append(document, non_visual_properties, "p:extLst")
    extension = _append(
        document,
        extension_list,
        "p:ext",
        {"uri": "{DAA4B4D4-6D71-4841-9C94-3DE7FCFB9230}"},
    )
    _append(
        document,
        extension,
        "p14:media",
        {
            "xmlns:p14": "http://schemas.microsoft.com/office/powerpoint/2010/main",
            "r:embed": media_relationship_id,
        },
    )
    blip_fill = _append(document, picture, "p:blipFill")
    _append(document, blip_fill, "a:blip", {"r:embed": poster_relationship_id})
    stretch = _append(document, blip_fill, "a:stretch")
    _append(document, stretch, "a:fillRect")
    _append_geometry(document, picture, placement)


def _add_relationship(document, relationship_id: str, relationship_type: str, target: str) -> None:
    _append(
        document,
        document.documentElement,
        "Relationship",
        {"Id": relationship_id, "Type": relationship_type, "Target": target},
    )


def _append_condition(document, parent, *, event: str | None = None, shape_id: int | None = None):
    attributes: dict[str, object] = {"delay": "0"}
    if event is not None:
        attributes["evt"] = event
    condition = _append(document, parent, "p:cond", attributes)
    if shape_id is not None:
        target = _append(document, condition, "p:tgtEl")
        _append(document, target, "p:spTgt", {"spid": shape_id})
    return condition


def _append_video_timing(document, videos: Sequence[tuple[int, int]]) -> None:
    if not videos:
        return
    slide = document.documentElement
    timing = _append(document, slide, "p:timing")
    timing_list = _append(document, timing, "p:tnLst")
    root_parallel = _append(document, timing_list, "p:par")
    next_id = 1

    def timing_node(parent, attributes: dict[str, object] | None = None):
        nonlocal next_id
        values: dict[str, object] = {"id": next_id}
        next_id += 1
        values.update(attributes or {})
        return _append(document, parent, "p:cTn", values)

    root = timing_node(
        root_parallel,
        {"dur": "indefinite", "restart": "never", "nodeType": "tmRoot"},
    )
    root_children = _append(document, root, "p:childTnLst")
    main_sequence = _append(document, root_children, "p:seq", {"concurrent": "1", "nextAc": "seek"})
    main = timing_node(main_sequence, {"dur": "indefinite", "nodeType": "mainSeq"})
    main_children = _append(document, main, "p:childTnLst")

    for shape_id, duration_ms in videos:
        outer_parallel = _append(document, main_children, "p:par")
        outer = timing_node(outer_parallel, {"fill": "hold"})
        starts = _append(document, outer, "p:stCondLst")
        _append(document, starts, "p:cond", {"delay": "indefinite"})
        outer_children = _append(document, outer, "p:childTnLst")
        middle_parallel = _append(document, outer_children, "p:par")
        middle = timing_node(middle_parallel, {"fill": "hold"})
        middle_starts = _append(document, middle, "p:stCondLst")
        _append_condition(document, middle_starts)
        middle_children = _append(document, middle, "p:childTnLst")
        click_parallel = _append(document, middle_children, "p:par")
        click = timing_node(
            click_parallel,
            {
                "presetID": "1",
                "presetClass": "mediacall",
                "presetSubtype": "0",
                "fill": "hold",
                "nodeType": "clickEffect",
            },
        )
        click_starts = _append(document, click, "p:stCondLst")
        _append_condition(document, click_starts)
        click_children = _append(document, click, "p:childTnLst")
        command = _append(document, click_children, "p:cmd", {"type": "call", "cmd": "playFrom(0.0)"})
        behavior = _append(document, command, "p:cBhvr")
        timing_node(behavior, {"dur": max(1, duration_ms), "fill": "hold"})
        target = _append(document, behavior, "p:tgtEl")
        _append(document, target, "p:spTgt", {"spid": shape_id})

    previous = _append(document, main_sequence, "p:prevCondLst")
    previous_condition = _append(
        document, previous, "p:cond", {"evt": "onPrev", "delay": "0"}
    )
    previous_target = _append(document, previous_condition, "p:tgtEl")
    _append(document, previous_target, "p:sldTgt")
    following = _append(document, main_sequence, "p:nextCondLst")
    following_condition = _append(
        document, following, "p:cond", {"evt": "onNext", "delay": "0"}
    )
    following_target = _append(document, following_condition, "p:tgtEl")
    _append(document, following_target, "p:sldTgt")

    for shape_id, _duration_ms in videos:
        video = _append(document, root_children, "p:video")
        media_node = _append(document, video, "p:cMediaNode", {"vol": "80000"})
        media_timing = timing_node(media_node, {"fill": "hold", "display": "0"})
        media_starts = _append(document, media_timing, "p:stCondLst")
        _append(document, media_starts, "p:cond", {"delay": "indefinite"})
        media_target = _append(document, media_node, "p:tgtEl")
        _append(document, media_target, "p:spTgt", {"spid": shape_id})

        interactive = _append(
            document, root_children, "p:seq", {"concurrent": "1", "nextAc": "seek"}
        )
        interaction = timing_node(
            interactive,
            {
                "restart": "whenNotActive",
                "fill": "hold",
                "evtFilter": "cancelBubble",
                "nodeType": "interactiveSeq",
            },
        )
        interaction_starts = _append(document, interaction, "p:stCondLst")
        _append_condition(document, interaction_starts, event="onClick", shape_id=shape_id)
        end_sync = _append(document, interaction, "p:endSync", {"evt": "end", "delay": "0"})
        _append(document, end_sync, "p:rtn", {"val": "all"})
        interaction_children = _append(document, interaction, "p:childTnLst")
        first_parallel = _append(document, interaction_children, "p:par")
        first = timing_node(first_parallel, {"fill": "hold"})
        first_starts = _append(document, first, "p:stCondLst")
        _append_condition(document, first_starts)
        first_children = _append(document, first, "p:childTnLst")
        second_parallel = _append(document, first_children, "p:par")
        second = timing_node(second_parallel, {"fill": "hold"})
        second_starts = _append(document, second, "p:stCondLst")
        _append_condition(document, second_starts)
        second_children = _append(document, second, "p:childTnLst")
        toggle_parallel = _append(document, second_children, "p:par")
        toggle = timing_node(
            toggle_parallel,
            {
                "presetID": "2",
                "presetClass": "mediacall",
                "presetSubtype": "0",
                "fill": "hold",
                "nodeType": "clickEffect",
            },
        )
        toggle_starts = _append(document, toggle, "p:stCondLst")
        _append_condition(document, toggle_starts)
        toggle_children = _append(document, toggle, "p:childTnLst")
        command = _append(document, toggle_children, "p:cmd", {"type": "call", "cmd": "togglePause"})
        behavior = _append(document, command, "p:cBhvr")
        timing_node(behavior, {"dur": "1", "fill": "hold"})
        target = _append(document, behavior, "p:tgtEl")
        _append(document, target, "p:spTgt", {"spid": shape_id})
        next_conditions = _append(document, interactive, "p:nextCondLst")
        _append_condition(document, next_conditions, event="onClick", shape_id=shape_id)


def _existing_media(
    parts: dict[str, bytes],
) -> tuple[dict[tuple[str, str], str], int, int]:
    by_hash_and_extension: dict[tuple[str, str], str] = {}
    maximum_image = 0
    maximum_video = 0
    for name, data in parts.items():
        if not name.startswith("ppt/media/"):
            continue
        extension = Path(name).suffix.lstrip(".").casefold()
        by_hash_and_extension.setdefault((_sha256(data), extension), name)
        image_match = re.fullmatch(r"ppt/media/image(\d+)\.[^.]+", name)
        video_match = re.fullmatch(r"ppt/media/media(\d+)\.[^.]+", name)
        if image_match:
            maximum_image = max(maximum_image, int(image_match.group(1)))
        if video_match:
            maximum_video = max(maximum_video, int(video_match.group(1)))
    return by_hash_and_extension, maximum_image + 1, maximum_video + 1


def _prepare_media(
    parts: dict[str, bytes], specs: Sequence[SlideSpec], check_cancel: Callable[[], None]
) -> tuple[dict[str, MediaParts], int]:
    by_hash_and_extension, next_image, next_video = _existing_media(parts)
    asset_media: dict[str, MediaParts] = {}
    added = 0
    for spec in specs:
        for asset in spec.assets:
            check_cancel()
            poster_digest = _sha256(asset.display_bytes)
            poster_key = (poster_digest, asset.display_extension)
            poster_name = by_hash_and_extension.get(poster_key)
            if poster_name is None:
                poster_name = f"ppt/media/image{next_image}.{asset.display_extension}"
                next_image += 1
                parts[poster_name] = asset.display_bytes
                by_hash_and_extension[poster_key] = poster_name
                added += 1
            _ensure_content_type(parts, Path(poster_name).suffix.lstrip("."))
            video_name: str | None = None
            if asset.kind == "video":
                assert asset.video_bytes is not None and asset.video_extension is not None
                video_digest = _sha256(asset.video_bytes)
                video_key = (video_digest, asset.video_extension)
                video_name = by_hash_and_extension.get(video_key)
                if video_name is None:
                    video_name = f"ppt/media/media{next_video}.{asset.video_extension}"
                    next_video += 1
                    parts[video_name] = asset.video_bytes
                    by_hash_and_extension[video_key] = video_name
                    added += 1
                _ensure_content_type(parts, Path(video_name).suffix.lstrip("."))
            asset_media[asset.asset_id] = MediaParts(poster=poster_name, video=video_name)
            check_cancel()
    return asset_media, added


def _populate_slide(
    base_slide: bytes,
    base_relationships: bytes,
    spec: SlideSpec,
    layout: LayoutResult | None,
    asset_media: dict[str, MediaParts],
) -> tuple[bytes, bytes]:
    slide = _parse_xml(base_slide, "ppt/slides/slide2.xml")
    relationships = _parse_xml(base_relationships, "ppt/slides/_rels/slide2.xml.rels")
    _update_title(slide, spec.title)
    if layout is None:
        return _serialize_xml(slide), _serialize_xml(relationships)
    _move_label(slide, "Master", layout.master_bounds.center_x if layout.master_bounds else None)
    _move_label(
        slide,
        "Adapt",
        layout.deliverables_bounds.center_x if layout.deliverables_bounds else None,
    )
    trees = slide.getElementsByTagName("p:spTree")
    if len(trees) != 1:
        raise BuildError("Template slide must contain exactly one p:spTree")
    tree = trees[0]
    shape_ids = [
        int(node.getAttribute("id"))
        for node in slide.getElementsByTagName("p:cNvPr")
        if node.getAttribute("id").isdigit()
    ]
    next_shape_id = max(shape_ids, default=0) + 1
    next_relationship_id = _next_rid(relationships.getElementsByTagName("Relationship"))
    videos: list[tuple[int, int]] = []
    for placement in layout.placements:
        media = asset_media[placement.asset.asset_id]
        poster_relationship_id = f"rId{next_relationship_id}"
        next_relationship_id += 1
        _add_relationship(
            relationships,
            poster_relationship_id,
            IMAGE_REL_TYPE,
            f"../media/{Path(media.poster).name}",
        )
        if placement.asset.kind == "image":
            _append_picture(slide, tree, placement, next_shape_id, poster_relationship_id)
        else:
            assert media.video is not None
            media_relationship_id = f"rId{next_relationship_id}"
            next_relationship_id += 1
            video_relationship_id = f"rId{next_relationship_id}"
            next_relationship_id += 1
            video_target = f"../media/{Path(media.video).name}"
            _add_relationship(
                relationships, media_relationship_id, MEDIA_REL_TYPE, video_target
            )
            _add_relationship(
                relationships, video_relationship_id, VIDEO_REL_TYPE, video_target
            )
            _append_video_picture(
                slide,
                tree,
                placement,
                next_shape_id,
                media_relationship_id,
                video_relationship_id,
                poster_relationship_id,
            )
            videos.append((next_shape_id, placement.asset.duration_ms or 1))
        next_shape_id += 1
    _append_video_timing(slide, videos)
    return _serialize_xml(slide), _serialize_xml(relationships)


def _update_app_properties(parts: dict[str, bytes], specs: Sequence[SlideSpec]) -> None:
    name = "docProps/app.xml"
    if name not in parts:
        return
    document = _parse_xml(parts[name], name)
    slides_nodes = document.getElementsByTagName("Slides")
    old_slide_count = (
        int(_text(slides_nodes[0]))
        if slides_nodes and _text(slides_nodes[0]).isdigit()
        else 2
    )
    new_slide_count = len(specs) + 1
    if slides_nodes:
        _set_text(slides_nodes[0], str(new_slide_count))
    for variant in document.getElementsByTagName("vt:variant"):
        labels = variant.getElementsByTagName("vt:lpstr")
        if not labels or _text(labels[0]) != "Slide Titles":
            continue
        sibling = variant.nextSibling
        while sibling is not None and sibling.nodeType != sibling.ELEMENT_NODE:
            sibling = sibling.nextSibling
        if sibling is not None:
            counts = sibling.getElementsByTagName("vt:i4")
            if counts:
                _set_text(counts[0], str(new_slide_count))
        break
    title_vectors = document.getElementsByTagName("TitlesOfParts")
    if title_vectors:
        vectors = title_vectors[0].getElementsByTagName("vt:vector")
        if vectors:
            vector = vectors[0]
            entries = _direct_elements(vector, "vt:lpstr")
            old_titles = [_text(entry) for entry in entries[-old_slide_count:]]
            for entry in entries[-old_slide_count:]:
                vector.removeChild(entry)
            first_title = old_titles[0] if old_titles else "Passenger Cars - Europe"
            for title in [first_title, *(spec.title for spec in specs)]:
                entry = document.createElement("vt:lpstr")
                entry.appendChild(document.createTextNode(title))
                vector.appendChild(entry)
            vector.setAttribute("size", str(len(_direct_elements(vector, "vt:lpstr"))))
    parts[name] = _serialize_xml(document)


def _write_package(
    output: Path,
    parts: dict[str, bytes],
    infos: dict[str, zipfile.ZipInfo],
    original_order: Sequence[str],
    check_cancel: Callable[[], None],
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        prefix=f".{output.stem}-", suffix=".pptx", dir=output.parent, delete=False
    )
    temp_path = Path(handle.name)
    handle.close()
    try:
        with zipfile.ZipFile(temp_path, "w") as archive:
            written: set[str] = set()
            for name in original_order:
                check_cancel()
                if name not in parts or name in written:
                    continue
                archive.writestr(infos[name], parts[name])
                written.add(name)
            for name in sorted(set(parts) - written):
                check_cancel()
                info = zipfile.ZipInfo(name, FIXED_ZIP_TIME)
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o600 << 16
                archive.writestr(info, parts[name])
        check_cancel()
        os.replace(temp_path, output)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _asset_report(
    raw: AssetInput,
    prepared_by_id: dict[str, PreparedAsset],
    media: dict[str, MediaParts],
) -> dict[str, object]:
    prepared = prepared_by_id.get(raw.asset_id)
    media_parts = media.get(raw.asset_id)
    report: dict[str, object] = {
        "assetId": raw.asset_id,
        "kind": raw.kind,
        "path": str(raw.path),
        "priority": raw.priority,
        "sha256": raw.sha256,
        "actualSha256": prepared.actual_sha256 if prepared else None,
        "warnings": list(raw.warnings),
        "posterPart": media_parts.poster if media_parts else None,
        "videoPart": media_parts.video if media_parts else None,
    }
    if raw.kind == "video":
        report.update(
            {
                "posterPath": str(raw.poster_path),
                "widthPx": raw.width_px,
                "heightPx": raw.height_px,
                "durationMs": raw.duration_ms,
                "extension": raw.extension,
                "compatibility": raw.compatibility,
            }
        )
    return report


def _placement_report(placement: Placement) -> dict[str, object]:
    report = placement.as_dict()
    dpi = min(
        placement.asset.width_px / placement.rect.width,
        placement.asset.height_px / placement.rect.height,
    )
    report.update(
        {
            "effectiveDpi": round(dpi, 1),
            "transparent": placement.asset.has_transparency,
            "animatedGif": placement.asset.is_animated,
            "compatibility": placement.asset.compatibility,
            "warnings": list(placement.asset.warnings),
            "sha256": placement.asset.actual_sha256,
        }
    )
    return report


def build_presentation(
    template: Path,
    specs: Sequence[SlideSpec],
    layouts: Sequence[LayoutResult | None],
    output: Path,
    report_path: Path,
    check_cancel: Callable[[], None],
    on_compose: Callable[[int, int, SlideSpec], None],
    on_save: Callable[[], None],
) -> dict[str, object]:
    if len(specs) != len(layouts):
        raise BuildError("Slide specs and layout decisions have different lengths")
    if not specs:
        raise BuildError("Manifest must contain at least one ticket")
    parts, infos, original_order = _load_template(template)
    slide1_hashes_before = {
        "slideXml": _member_hash(parts, "ppt/slides/slide1.xml"),
        "slideRelationships": _member_hash(
            parts, "ppt/slides/_rels/slide1.xml.rels"
        ),
    }
    base_slide = parts["ppt/slides/slide2.xml"]
    base_relationships = parts["ppt/slides/_rels/slide2.xml.rels"]
    slide_count = len(specs) + 1
    for slide_number in range(3, slide_count + 1):
        parts[f"ppt/slides/slide{slide_number}.xml"] = base_slide
        parts[f"ppt/slides/_rels/slide{slide_number}.xml.rels"] = base_relationships
    _register_slides(parts, slide_count)
    media, media_added = _prepare_media(parts, specs, check_cancel)
    total = len(specs)
    for index, (spec, layout) in enumerate(zip(specs, layouts, strict=True), start=1):
        check_cancel()
        on_compose(index, total, spec)
        slide_data, relationship_data = _populate_slide(
            base_slide, base_relationships, spec, layout, media
        )
        slide_number = index + 1
        parts[f"ppt/slides/slide{slide_number}.xml"] = slide_data
        parts[f"ppt/slides/_rels/slide{slide_number}.xml.rels"] = relationship_data
        check_cancel()
    _update_app_properties(parts, specs)
    slide1_hashes_after = {
        "slideXml": _member_hash(parts, "ppt/slides/slide1.xml"),
        "slideRelationships": _member_hash(
            parts, "ppt/slides/_rels/slide1.xml.rels"
        ),
    }
    if slide1_hashes_before != slide1_hashes_after:
        raise BuildError("Intro slide changed during generation")
    check_cancel()
    on_save()
    _write_package(output, parts, infos, original_order, check_cancel)

    slide_reports: list[dict[str, object]] = []
    video_count = 0
    for slide_number, (spec, layout) in enumerate(
        zip(specs, layouts, strict=True), start=2
    ):
        prepared_by_id = {asset.asset_id: asset for asset in spec.assets}
        selected = [*spec.selected_master, *spec.selected_deliverables]
        video_count += sum(asset.kind == "video" for asset in spec.assets)
        slide_reports.append(
            {
                "slideNumber": slide_number,
                "ticket": spec.name,
                "title": spec.title,
                "blankReason": spec.blank_reason,
                "selected": {
                    "master": [asset.path.name for asset in spec.selected_master],
                    "deliverables": [
                        asset.path.name for asset in spec.selected_deliverables
                    ],
                },
                "media": [
                    _asset_report(asset, prepared_by_id, media) for asset in selected
                ],
                "layout": (
                    {
                        "id": layout.layout_id,
                        "score": round(layout.score, 6),
                        "masterBounds": (
                            layout.master_bounds.as_dict()
                            if layout.master_bounds
                            else None
                        ),
                        "deliverablesBounds": (
                            layout.deliverables_bounds.as_dict()
                            if layout.deliverables_bounds
                            else None
                        ),
                    }
                    if layout
                    else None
                ),
                "placements": (
                    [_placement_report(item) for item in layout.placements]
                    if layout
                    else []
                ),
                "warnings": [
                    *spec.warnings,
                    *(layout.warnings if layout is not None else []),
                ],
            }
        )
    return {
        "schemaVersion": 1,
        "template": str(template),
        "output": str(output),
        "report": str(report_path),
        "slideCount": slide_count,
        "contentSlideCount": len(specs),
        "blankTicketCount": sum(spec.blank_reason is not None for spec in specs),
        "videoCount": video_count,
        "uniqueMediaAdded": media_added,
        "minimumEffectiveDpi": MIN_EFFECTIVE_DPI,
        "introPreserved": True,
        "introHashes": slide1_hashes_after,
        "slides": slide_reports,
    }
