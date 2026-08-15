from __future__ import annotations

import itertools
from pathlib import Path

import pytest

from horizon_pptx.layout import BAND, SECTION_GAP, optimize_layout
from horizon_pptx.models import PreparedAsset, SlideSpec


def _asset(identifier: str, section: str, aspect: float) -> PreparedAsset:
    height = 1000
    return PreparedAsset(
        asset_id=identifier,
        kind="image",
        path=Path(f"{identifier}.png"),
        section=section,  # type: ignore[arg-type]
        width_px=round(height * aspect),
        height_px=height,
        priority=3,
        display_bytes=b"image",
    )


def test_layout_is_deterministic_non_overlapping_and_never_crops() -> None:
    spec = SlideSpec(
        name="P1",
        title="Ticket",
        master=[_asset("m1", "master", 1.0), _asset("m2", "master", 1.78)],
        deliverables=[
            _asset(f"d{index}", "deliverables", aspect)
            for index, aspect in enumerate((0.56, 1.0, 1.33, 1.78, 3.0, 0.8), start=1)
        ],
    )
    first = optimize_layout(spec)
    second = optimize_layout(spec)
    assert first.layout_id == second.layout_id
    assert [item.rect for item in first.placements] == [
        item.rect for item in second.placements
    ]
    for placement in first.placements:
        rect = placement.rect
        assert rect.x >= BAND.x - 1e-5
        assert rect.y >= BAND.y - 1e-5
        assert rect.right <= BAND.right + 1e-5
        assert rect.bottom <= BAND.bottom + 1e-5
        assert rect.width / rect.height == pytest.approx(
            placement.asset.aspect_ratio, rel=1e-5
        )
    for left, right in itertools.combinations(first.placements, 2):
        horizontal = min(left.rect.right, right.rect.right) - max(
            left.rect.x, right.rect.x
        )
        vertical = min(left.rect.bottom, right.rect.bottom) - max(
            left.rect.y, right.rect.y
        )
        assert horizontal <= 1e-5 or vertical <= 1e-5
    assert first.master_bounds is not None
    assert first.deliverables_bounds is not None
    assert (
        first.master_bounds.right + SECTION_GAP
        <= first.deliverables_bounds.x + 1e-5
    )

