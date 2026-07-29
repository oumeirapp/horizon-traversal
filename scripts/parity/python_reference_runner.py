#!/usr/bin/env python3
"""Run the legacy pipeline and persist its structured observations as JSON."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repository", required=True, type=Path)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--result", required=True, type=Path)
    parser.add_argument("--filter", default="P1-P3")
    return parser.parse_args()


def resolved(path: str | Path) -> str:
    return str(Path(path).resolve(strict=True))


def main() -> None:
    args = parse_args()
    sys.path.insert(0, str(args.repository / "python"))

    # Imports resolve native tools immediately, after the parity test has
    # installed its temporary, unsuffixed PATH entries.
    import pipeline  # noqa: PLC0415
    from app import App  # noqa: PLC0415

    expected_ffmpeg = os.environ["X_TRAVERSAL_EXPECT_FFMPEG"]
    expected_ffprobe = os.environ["X_TRAVERSAL_EXPECT_FFPROBE"]
    actual_ffmpeg = resolved(pipeline.FFMPEG)
    actual_ffprobe = resolved(pipeline.FFPROBE)
    if actual_ffmpeg != resolved(expected_ffmpeg):
        raise RuntimeError(
            f"Python resolved unexpected ffmpeg: {actual_ffmpeg}"
        )
    if actual_ffprobe != resolved(expected_ffprobe):
        raise RuntimeError(
            f"Python resolved unexpected ffprobe: {actual_ffprobe}"
        )

    rules = App._parse_filter(args.filter)
    tickets = sorted(
        (
            path
            for path in args.input.iterdir()
            if path.is_dir() and App._folder_matches(None, path.name, rules)
        ),
        key=lambda path: path.name,
    )

    # This is the documented invalid-filter delta: the legacy parser silently
    # discarded the empty token following a trailing comma.
    invalid_filter_accepted = False
    try:
        App._parse_filter("P1,")
        invalid_filter_accepted = True
    except ValueError:
        pass

    logs: list[dict[str, str]] = []
    pipeline.set_log_sink(
        lambda entry: logs.append(
            {"level": entry.level.value, "message": entry.message}
        )
    )
    pipeline.process_all(
        root=str(args.input),
        output_dir=str(args.output),
        folders=[str(path) for path in tickets],
    )
    pipeline.set_log_sink(None)

    result = {
        "tickets": [path.name for path in tickets],
        "logs": logs,
        "invalidFilterAccepted": invalid_filter_accepted,
        "ffmpeg": actual_ffmpeg,
        "ffprobe": actual_ffprobe,
    }
    args.result.parent.mkdir(parents=True, exist_ok=True)
    args.result.write_text(json.dumps(result, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
