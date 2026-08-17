from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from defusedxml import minidom
from PIL import Image

from horizon_pptx.cli import CANCELLED_EXIT_CODE, main
from horizon_pptx.manifest import AssetError, _video_poster


ROOT = Path(__file__).resolve().parents[1]
TEMPLATE = ROOT / "resources" / "Slide template.pptx"
VALIDATOR = ROOT.parent / ".agents" / "skills" / "pptx" / "scripts" / "office" / "validate.py"
EXPECTED_TEMPLATE_SHA256 = "b1cb647f4856619b2a5447b95a1505fea77ab599925cf51bb0044b844592a366"


def _image(path: Path, size: tuple[int, int] = (640, 360), color: str = "navy") -> None:
    Image.new("RGB", size, color).save(path, format="PNG")


def _write_manifest(
    tmp_path: Path, tickets: list[dict[str, object]], *, cancel: bool = False
) -> Path:
    cancel_path = tmp_path / "cancel.request"
    if cancel:
        cancel_path.touch()
    manifest = {
        "schemaVersion": 1,
        "template": str(TEMPLATE),
        "output": str(tmp_path / "built.pptx"),
        "report": str(tmp_path / "built.report.json"),
        "cancelPath": str(cancel_path),
        "tickets": tickets,
    }
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return path


def _image_asset(path: Path, priority: int = 3) -> dict[str, object]:
    return {"kind": "image", "path": str(path), "priority": priority}


def _video_asset(
    video: Path,
    poster: Path,
    extension: str,
    payload: bytes,
) -> dict[str, object]:
    return {
        "kind": "video",
        "path": str(video),
        "posterPath": str(poster),
        "priority": 4,
        "widthPx": 640,
        "heightPx": 360,
        "durationMs": 2345,
        "extension": extension,
        "compatibility": "powerpoint-native",
        "sha256": hashlib.sha256(payload).hexdigest(),
        "warnings": ["source audit warning"],
    }


def test_template_is_exact_migration_copy() -> None:
    assert hashlib.sha256(TEMPLATE.read_bytes()).hexdigest() == EXPECTED_TEMPLATE_SHA256


def test_corrupt_selected_image_blanks_whole_ticket_and_blank_tickets_get_slides(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    good = tmp_path / "good.png"
    corrupt = tmp_path / "corrupt.png"
    _image(good)
    corrupt.write_bytes(b"this is not an image")
    manifest = _write_manifest(
        tmp_path,
        [
            {
                "name": "P100",
                "title": "Corrupt selection",
                "master": [_image_asset(good), _image_asset(corrupt)],
                "deliverables": [],
            },
            {
                "name": "P101",
                "title": "Known blank",
                "blankReason": "No approved media.",
                "master": [],
                "deliverables": [],
            },
            {
                "name": "P102",
                "title": "Implicit blank",
                "master": [],
                "deliverables": [],
            },
        ],
    )

    assert main(["build-manifest", str(manifest)]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1]["event"] == "completed"
    assert events[-1]["summary"]["slidesCreated"] == 3
    assert events[-1]["summary"]["blankSlides"] == 3
    assert all(event["protocol"] == 1 for event in events)

    report = json.loads((tmp_path / "built.report.json").read_text(encoding="utf-8"))
    assert report["slideCount"] == 4
    assert report["blankTicketCount"] == 3
    assert report["slides"][0]["blankReason"].startswith("Corrupt selected asset:")
    assert report["slides"][1]["blankReason"] == "No approved media."
    assert report["slides"][2]["blankReason"] == "No selected media."
    assert report["slides"][0]["placements"] == []

    with zipfile.ZipFile(tmp_path / "built.pptx") as archive:
        corrupt_slide = archive.read("ppt/slides/slide2.xml")
        explicit_blank_slide = archive.read("ppt/slides/slide3.xml")
        implicit_blank_slide = archive.read("ppt/slides/slide4.xml")
        assert b"P100" in corrupt_slide
        assert b"P101" in explicit_blank_slide
        assert b"P102" in implicit_blank_slide
        assert b"<p:pic>" not in corrupt_slide
        assert b"<p:pic>" not in explicit_blank_slide
        assert b"<p:pic>" not in implicit_blank_slide
        with zipfile.ZipFile(TEMPLATE) as template_archive:
            assert archive.read("ppt/slides/slide1.xml") == template_archive.read(
                "ppt/slides/slide1.xml"
            )
            assert archive.read(
                "ppt/slides/_rels/slide1.xml.rels"
            ) == template_archive.read("ppt/slides/_rels/slide1.xml.rels")


def test_decompression_bomb_image_uses_the_blank_ticket_fallback(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    image = tmp_path / "oversized.png"
    image.write_bytes(b"placeholder")
    manifest = _write_manifest(
        tmp_path,
        [
            {
                "name": "P150",
                "title": "Oversized selection",
                "master": [_image_asset(image)],
                "deliverables": [],
            }
        ],
    )

    def raise_decompression_bomb(*_args: object, **_kwargs: object) -> None:
        raise Image.DecompressionBombError("pixel limit exceeded")

    monkeypatch.setattr("horizon_pptx.manifest.Image.open", raise_decompression_bomb)

    assert main(["build-manifest", str(manifest)]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events[-1]["summary"]["slidesCreated"] == 1
    assert events[-1]["summary"]["blankSlides"] == 1
    assert events[-1]["summary"]["warnings"] == 2
    warnings = [event for event in events if event.get("level") == "warning"]
    assert len(warnings) == events[-1]["summary"]["warnings"]
    assert warnings[0]["message"].startswith("Selected media could not be used:")
    assert warnings[1]["message"].startswith("Using a blank ticket slide:")
    report = json.loads((tmp_path / "built.report.json").read_text(encoding="utf-8"))
    assert report["slides"][0]["blankReason"].startswith("Corrupt selected asset:")
    assert "pixel limit exceeded" in report["slides"][0]["blankReason"]
    assert report["slides"][0]["warnings"][-1].startswith(
        "Using a blank ticket slide:"
    )


def test_decompression_bomb_video_poster_is_an_asset_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    poster = tmp_path / "poster.jpg"
    poster.write_bytes(b"placeholder")

    def raise_decompression_bomb(*_args: object, **_kwargs: object) -> None:
        raise Image.DecompressionBombError("poster pixel limit exceeded")

    monkeypatch.setattr("horizon_pptx.manifest.Image.open", raise_decompression_bomb)

    with pytest.raises(AssetError, match="poster pixel limit exceeded"):
        _video_poster(poster, 1920, 1080)


@pytest.mark.parametrize(
    ("extension", "content_type"),
    [("mp4", "video/mp4"), ("avi", "video/avi")],
)
def test_raw_video_bytes_relationships_timing_and_report_are_preserved(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    extension: str,
    content_type: str,
) -> None:
    poster = tmp_path / "poster.png"
    _image(poster, (320, 240), "teal")
    payload = b"raw-video-container\x00\x01" + extension.encode("ascii")
    video = tmp_path / f"clip.{extension}"
    video.write_bytes(payload)
    manifest = _write_manifest(
        tmp_path,
        [
            {
                "name": "P200",
                "title": "Video ticket",
                "master": [],
                "deliverables": [
                    _video_asset(video, poster, extension, payload),
                ],
            }
        ],
    )

    assert main(["build-manifest", str(manifest)]) == 0
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    progress = [event for event in events if event["event"] == "progress"]
    warnings = [event for event in events if event.get("level") == "warning"]
    assert len(warnings) == 1
    assert "Low effective resolution" in warnings[0]["message"]
    assert "source audit warning" not in warnings[0]["message"]
    assert events[-1]["summary"]["warnings"] == 2
    assert [event["step"] for event in progress] == ["layout", "compose", "save"]
    assert set(progress[0]) >= {
        "protocol",
        "event",
        "step",
        "ticket",
        "index",
        "total",
        "message",
    }

    report = json.loads((tmp_path / "built.report.json").read_text(encoding="utf-8"))
    media_report = report["slides"][0]["media"][0]
    assert media_report["compatibility"] == "powerpoint-native"
    assert media_report["warnings"] == ["source audit warning"]
    assert media_report["sha256"] == hashlib.sha256(payload).hexdigest()
    assert media_report["actualSha256"] == media_report["sha256"]
    assert report["introPreserved"] is True
    assert report["slides"][0]["blankReason"] is None
    assert report["slides"][0]["layout"] is not None
    assert len(report["slides"][0]["placements"]) == 1
    video_part = media_report["videoPart"]
    poster_part = media_report["posterPart"]

    with zipfile.ZipFile(tmp_path / "built.pptx") as archive:
        embedded = archive.read(video_part)
        assert embedded == payload
        assert hashlib.sha256(embedded).hexdigest() == media_report["sha256"]
        assert archive.read(poster_part).startswith(b"\x89PNG\r\n\x1a\n")

        relationships = minidom.parseString(
            archive.read("ppt/slides/_rels/slide2.xml.rels")
        )
        relation_rows = [
            (
                item.getAttribute("Id"),
                item.getAttribute("Type"),
                item.getAttribute("Target"),
            )
            for item in relationships.getElementsByTagName("Relationship")
        ]
        video_target = f"../media/{Path(video_part).name}"
        matching_types = {
            relation_type
            for _identifier, relation_type, target in relation_rows
            if target == video_target
        }
        assert matching_types == {
            "http://schemas.microsoft.com/office/2007/relationships/media",
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/video",
        }

        slide = minidom.parseString(archive.read("ppt/slides/slide2.xml"))
        assert len(slide.getElementsByTagName("a:videoFile")) == 1
        assert len(slide.getElementsByTagName("p14:media")) == 1
        assert len(slide.getElementsByTagName("p:timing")) == 1
        commands = {
            item.getAttribute("cmd") for item in slide.getElementsByTagName("p:cmd")
        }
        assert commands == {"playFrom(0.0)", "togglePause"}
        timing_ids = [
            item.getAttribute("id") for item in slide.getElementsByTagName("p:cTn")
        ]
        assert len(timing_ids) == len(set(timing_ids))
        shape_ids = [
            item.getAttribute("id")
            for item in slide.getElementsByTagName("p:cNvPr")
            if item.getAttribute("id")
        ]
        assert len(shape_ids) == len(set(shape_ids))

        content_types = minidom.parseString(archive.read("[Content_Types].xml"))
        assert any(
            item.getAttribute("Extension") == extension
            and item.getAttribute("ContentType") == content_type
            for item in content_types.getElementsByTagName("Default")
        )

    # The shared validator opens XML in text mode. Make its declared UTF-8
    # content independent of Windows' legacy process code page.
    validation = subprocess.run(
        [
            sys.executable,
            "-X",
            "utf8=1",
            str(VALIDATOR),
            str(tmp_path / "built.pptx"),
            "--original",
            str(TEMPLATE),
        ],
        check=False,
        capture_output=True,
        env={
            **os.environ,
            "LANG": "C",
            "LC_ALL": "C",
            "PYTHONCOERCECLOCALE": "0",
            "PYTHONIOENCODING": "utf-8",
        },
        encoding="utf-8",
    )
    assert validation.returncode == 0, validation.stdout + validation.stderr
    assert "All validations PASSED" in validation.stdout


def test_preexisting_cancel_path_emits_cancelled_and_returns_distinct_code(
    tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    manifest = _write_manifest(
        tmp_path,
        [
            {
                "name": "P300",
                "title": "Cancelled",
                "master": [],
                "deliverables": [],
            }
        ],
        cancel=True,
    )
    assert main(["build-manifest", str(manifest)]) == CANCELLED_EXIT_CODE
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines()]
    assert events == [
        {
            "protocol": 1,
            "event": "cancelled",
            "message": f"Cancellation requested by {tmp_path / 'cancel.request'}",
        }
    ]
    assert not (tmp_path / "built.pptx").exists()
    assert not (tmp_path / "built.report.json").exists()
