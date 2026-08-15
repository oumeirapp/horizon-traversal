from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


Section = Literal["master", "deliverables"]
MediaKind = Literal["image", "video"]


@dataclass(frozen=True)
class Rect:
    x: float
    y: float
    width: float
    height: float

    @property
    def right(self) -> float:
        return self.x + self.width

    @property
    def bottom(self) -> float:
        return self.y + self.height

    @property
    def center_x(self) -> float:
        return self.x + self.width / 2

    @property
    def center_y(self) -> float:
        return self.y + self.height / 2

    @property
    def area(self) -> float:
        return self.width * self.height

    def as_dict(self) -> dict[str, float]:
        return {
            "x": round(self.x, 4),
            "y": round(self.y, 4),
            "width": round(self.width, 4),
            "height": round(self.height, 4),
        }


@dataclass(frozen=True)
class AssetInput:
    asset_id: str
    kind: MediaKind
    path: Path
    priority: int
    poster_path: Path | None = None
    width_px: int | None = None
    height_px: int | None = None
    duration_ms: int | None = None
    extension: str | None = None
    compatibility: str | None = None
    sha256: str | None = None
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class TicketInput:
    name: str
    title: str
    blank_reason: str | None
    master: tuple[AssetInput, ...]
    deliverables: tuple[AssetInput, ...]
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class BuildManifest:
    source: Path
    template: Path
    output: Path
    report: Path
    cancel_path: Path
    tickets: tuple[TicketInput, ...]


@dataclass(frozen=True)
class PreparedAsset:
    asset_id: str
    kind: MediaKind
    path: Path
    section: Section
    width_px: int
    height_px: int
    priority: int
    display_bytes: bytes = field(repr=False, compare=False)
    display_extension: str = "png"
    has_transparency: bool = False
    is_animated: bool = False
    poster_path: Path | None = None
    video_bytes: bytes | None = field(default=None, repr=False, compare=False)
    video_extension: str | None = None
    duration_ms: int | None = None
    compatibility: str | None = None
    declared_sha256: str | None = None
    actual_sha256: str | None = None
    warnings: tuple[str, ...] = ()

    @property
    def aspect_ratio(self) -> float:
        return self.width_px / self.height_px


@dataclass
class SlideSpec:
    name: str
    title: str
    master: list[PreparedAsset]
    deliverables: list[PreparedAsset]
    selected_master: tuple[AssetInput, ...] = ()
    selected_deliverables: tuple[AssetInput, ...] = ()
    blank_reason: str | None = None
    warnings: list[str] = field(default_factory=list)

    @property
    def assets(self) -> list[PreparedAsset]:
        return [*self.master, *self.deliverables]


@dataclass(frozen=True)
class Placement:
    asset: PreparedAsset
    rect: Rect

    def as_dict(self) -> dict[str, object]:
        return {
            "assetId": self.asset.asset_id,
            "file": self.asset.path.name,
            "kind": self.asset.kind,
            "section": self.asset.section,
            "priority": self.asset.priority,
            "sourcePixels": [self.asset.width_px, self.asset.height_px],
            "aspectRatio": round(self.asset.aspect_ratio, 6),
            "rectInches": self.rect.as_dict(),
        }


@dataclass
class LayoutResult:
    placements: list[Placement]
    score: float
    layout_id: str
    master_bounds: Rect | None
    deliverables_bounds: Rect | None
    warnings: list[str] = field(default_factory=list)
