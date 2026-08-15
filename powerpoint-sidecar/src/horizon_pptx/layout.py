from __future__ import annotations

import itertools
import math
from collections.abc import Iterable, Sequence

from .models import LayoutResult, Placement, PreparedAsset, Rect, SlideSpec


BAND = Rect(0.40, 3.05, 12.29, 3.81)
ITEM_GAP = 0.16
SECTION_GAP = 0.20
MASTER_CENTER_X = 2.65
DELIVERABLES_CENTER_X = 9.00
MIN_EFFECTIVE_DPI = 120.0


def _contain(box: Rect, aspect_ratio: float) -> Rect:
    if box.width / box.height > aspect_ratio:
        height = box.height
        width = height * aspect_ratio
    else:
        width = box.width
        height = width / aspect_ratio
    return Rect(box.center_x - width / 2, box.center_y - height / 2, width, height)


def _bounds(placements: Sequence[Placement]) -> Rect:
    left = min(item.rect.x for item in placements)
    top = min(item.rect.y for item in placements)
    right = max(item.rect.right for item in placements)
    bottom = max(item.rect.bottom for item in placements)
    return Rect(left, top, right - left, bottom - top)


def _compositions(count: int) -> Iterable[tuple[int, ...]]:
    for mask in range(1 << max(0, count - 1)):
        groups: list[int] = []
        current = 1
        for boundary in range(count - 1):
            if mask & (1 << boundary):
                groups.append(current)
                current = 1
            else:
                current += 1
        groups.append(current)
        yield tuple(groups)


def _row_shelf(
    sequence: Sequence[PreparedAsset], composition: Sequence[int], box: Rect
) -> list[Placement]:
    rows: list[Sequence[PreparedAsset]] = []
    cursor = 0
    for size in composition:
        rows.append(sequence[cursor : cursor + size])
        cursor += size
    natural_heights = [
        (box.width - ITEM_GAP * (len(row) - 1)) / sum(item.aspect_ratio for item in row)
        for row in rows
    ]
    gaps = ITEM_GAP * (len(rows) - 1)
    scale = min(1.0, max(box.height - gaps, 0.0) / sum(natural_heights))
    heights = [height * scale for height in natural_heights]
    total_height = sum(heights) + gaps
    y = box.center_y - total_height / 2
    placements: list[Placement] = []
    for row, height in zip(rows, heights, strict=True):
        row_width = sum(item.aspect_ratio * height for item in row) + ITEM_GAP * (len(row) - 1)
        x = box.center_x - row_width / 2
        for asset in row:
            width = asset.aspect_ratio * height
            placements.append(Placement(asset, Rect(x, y, width, height)))
            x += width + ITEM_GAP
        y += height + ITEM_GAP
    return placements


def _column_shelf(
    sequence: Sequence[PreparedAsset], composition: Sequence[int], box: Rect
) -> list[Placement]:
    columns: list[Sequence[PreparedAsset]] = []
    cursor = 0
    for size in composition:
        columns.append(sequence[cursor : cursor + size])
        cursor += size
    natural_widths = [
        (box.height - ITEM_GAP * (len(column) - 1))
        / sum(1 / item.aspect_ratio for item in column)
        for column in columns
    ]
    gaps = ITEM_GAP * (len(columns) - 1)
    scale = min(1.0, max(box.width - gaps, 0.0) / sum(natural_widths))
    widths = [width * scale for width in natural_widths]
    total_width = sum(widths) + gaps
    x = box.center_x - total_width / 2
    placements: list[Placement] = []
    for column, width in zip(columns, widths, strict=True):
        column_height = sum(width / item.aspect_ratio for item in column) + ITEM_GAP * (
            len(column) - 1
        )
        y = box.center_y - column_height / 2
        for asset in column:
            height = width / asset.aspect_ratio
            placements.append(Placement(asset, Rect(x, y, width, height)))
            y += height + ITEM_GAP
        x += width + ITEM_GAP
    return placements


def _grid(sequence: Sequence[PreparedAsset], columns: int, box: Rect) -> list[Placement]:
    rows = math.ceil(len(sequence) / columns)
    cell_width = (box.width - ITEM_GAP * (columns - 1)) / columns
    cell_height = (box.height - ITEM_GAP * (rows - 1)) / rows
    placements: list[Placement] = []
    for index, asset in enumerate(sequence):
        row, column = divmod(index, columns)
        cell = Rect(
            box.x + column * (cell_width + ITEM_GAP),
            box.y + row * (cell_height + ITEM_GAP),
            cell_width,
            cell_height,
        )
        placements.append(Placement(asset, _contain(cell, asset.aspect_ratio)))
    return placements


def _score(placements: Sequence[Placement], box: Rect) -> float:
    weighted_area = sum(
        item.rect.area * (1.0 + max(-0.8, min(2.0, (item.asset.priority - 3) * 0.12)))
        for item in placements
    )
    union = _bounds(placements)
    density = sum(item.rect.area for item in placements) / max(union.area, 1e-9)
    balance = 1.0 - min(
        1.0,
        abs(union.center_x - box.center_x) / max(box.width / 2, 1e-9)
        + abs(union.center_y - box.center_y) / max(box.height / 2, 1e-9),
    )
    return weighted_area / box.area + 0.05 * density + 0.02 * balance


def _layout_group(
    assets: Sequence[PreparedAsset], box: Rect, preferred_center: float
) -> tuple[list[Placement], float, str, Rect]:
    if len(assets) == 1:
        maximum = Rect(
            max(box.x, preferred_center - min(box.width, 5.6) / 2),
            box.y,
            min(box.width, 5.6),
            box.height,
        )
        placement = Placement(assets[0], _contain(maximum, assets[0].aspect_ratio))
        return [placement], _score([placement], box), "single", placement.rect

    sequences = [tuple(assets)]
    priority_order = tuple(
        sorted(assets, key=lambda item: (-item.priority, item.asset_id))
    )
    if priority_order != sequences[0]:
        sequences.append(priority_order)
    candidates: list[tuple[float, str, list[Placement]]] = []
    for sequence_index, sequence in enumerate(sequences):
        for composition in _compositions(len(sequence)):
            label = "-".join(str(value) for value in composition)
            rows = _row_shelf(sequence, composition, box)
            columns = _column_shelf(sequence, composition, box)
            candidates.append((_score(rows, box), f"rows:{sequence_index}:{label}", rows))
            candidates.append((_score(columns, box), f"columns:{sequence_index}:{label}", columns))
        for columns_count in range(1, len(sequence) + 1):
            grid = _grid(sequence, columns_count, box)
            candidates.append(
                (_score(grid, box), f"grid:{sequence_index}:{columns_count}", grid)
            )
    candidates.sort(key=lambda item: (-round(item[0], 9), item[1]))
    score, identifier, placements = candidates[0]
    return placements, score, identifier, _bounds(placements)


def optimize_layout(spec: SlideSpec) -> LayoutResult:
    if spec.blank_reason is not None or not spec.assets:
        raise ValueError("Blank tickets do not have a media layout")
    if spec.master and spec.deliverables:
        split = 5.20
        master_box = Rect(BAND.x, BAND.y, split - SECTION_GAP / 2 - BAND.x, BAND.height)
        right = split + SECTION_GAP / 2
        deliverables_box = Rect(right, BAND.y, BAND.right - right, BAND.height)
    elif spec.master:
        master_box = Rect(BAND.x, BAND.y, 5.80, BAND.height)
        deliverables_box = Rect(3.70, BAND.y, BAND.right - 3.70, BAND.height)
    else:
        master_box = Rect(BAND.x, BAND.y, 5.80, BAND.height)
        deliverables_box = Rect(3.70, BAND.y, BAND.right - 3.70, BAND.height)

    placements: list[Placement] = []
    score_parts: list[float] = []
    identifiers: list[str] = []
    master_bounds: Rect | None = None
    deliverables_bounds: Rect | None = None
    if spec.master:
        group, score, identifier, master_bounds = _layout_group(
            spec.master, master_box, MASTER_CENTER_X
        )
        placements.extend(group)
        score_parts.append(score)
        identifiers.append(f"M={identifier}")
    if spec.deliverables:
        group, score, identifier, deliverables_bounds = _layout_group(
            spec.deliverables, deliverables_box, DELIVERABLES_CENTER_X
        )
        placements.extend(group)
        score_parts.append(score)
        identifiers.append(f"D={identifier}")

    warnings: list[str] = []
    for placement in placements:
        dpi = min(
            placement.asset.width_px / placement.rect.width,
            placement.asset.height_px / placement.rect.height,
        )
        if dpi < MIN_EFFECTIVE_DPI:
            warnings.append(
                f"Low effective resolution ({dpi:.0f} DPI): {placement.asset.path.name}"
            )
    return LayoutResult(
        placements=placements,
        score=sum(score_parts) / len(score_parts),
        layout_id=";".join(identifiers),
        master_bounds=master_bounds,
        deliverables_bounds=deliverables_bounds,
        warnings=warnings,
    )

