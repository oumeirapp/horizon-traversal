from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from . import __version__
from .builder import BuildError, build_presentation
from .layout import optimize_layout
from .manifest import ManifestError, load_manifest, prepare_ticket


CANCELLED_EXIT_CODE = 3


class Cancelled(RuntimeError):
    """Raised when the native host requests cancellation."""


class CancellationToken:
    def __init__(self, path: Path) -> None:
        self.path = path

    def check(self) -> None:
        if self.path.exists():
            raise Cancelled(f"Cancellation requested by {self.path}")


def _emit(event: str, **payload: Any) -> None:
    print(
        json.dumps(
            {"protocol": 1, "event": event, **payload},
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        flush=True,
    )


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="horizon-pptx",
        description="Build a Horizon PowerPoint deck from a schema-v1 manifest.",
    )
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command", required=True)
    build = commands.add_parser(
        "build-manifest", help="validate a schema-v1 manifest and build its PPTX"
    )
    build.add_argument("manifest", type=Path, help="path to the build manifest JSON")
    return parser


def _write_json_atomic(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        prefix=f".{path.stem}-",
        suffix=".json",
        dir=path.parent,
        delete=False,
    )
    temporary = Path(handle.name)
    try:
        with handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _build_manifest(path: Path) -> int:
    manifest = load_manifest(path)
    cancellation = CancellationToken(manifest.cancel_path)
    cancellation.check()
    _emit(
        "log",
        level="info",
        message=f"Loaded schema-v1 manifest with {len(manifest.tickets)} ticket(s).",
    )
    specs = []
    layouts = []
    total = len(manifest.tickets)
    for index, ticket in enumerate(manifest.tickets, start=1):
        cancellation.check()
        _emit(
            "progress",
            step="layout",
            ticket=ticket.name,
            index=index,
            total=total,
            message=f"Validating selected media and laying out {ticket.name}.",
        )
        spec = prepare_ticket(ticket, cancellation.check)
        if spec.blank_reason is not None and spec.blank_reason.startswith(
            "Corrupt selected asset:"
        ):
            for warning in spec.warnings[len(ticket.warnings) :]:
                _emit(
                    "log",
                    level="warning",
                    ticket=ticket.name,
                    message=f"Selected media could not be used: {warning}",
                )
        specs.append(spec)
        layout = None if spec.blank_reason is not None else optimize_layout(spec)
        layouts.append(layout)
        if layout is not None:
            for warning in layout.warnings:
                _emit(
                    "log",
                    level="warning",
                    ticket=ticket.name,
                    message=warning,
                )
        if spec.blank_reason is not None:
            warning = f"Using a blank ticket slide: {spec.blank_reason}"
            spec.warnings.append(warning)
            _emit(
                "log",
                level="warning",
                ticket=ticket.name,
                message=warning,
            )
        cancellation.check()

    def on_compose(index: int, total_count: int, spec) -> None:
        _emit(
            "progress",
            step="compose",
            ticket=spec.name,
            index=index,
            total=total_count,
            message=f"Composing slide for {spec.name}.",
        )

    def on_save() -> None:
        _emit(
            "progress",
            step="save",
            ticket="",
            index=1,
            total=1,
            message=f"Saving {manifest.output.name}.",
        )

    report = build_presentation(
        template=manifest.template,
        specs=specs,
        layouts=layouts,
        output=manifest.output,
        report_path=manifest.report,
        check_cancel=cancellation.check,
        on_compose=on_compose,
        on_save=on_save,
    )
    _write_json_atomic(manifest.report, report)
    warning_count = sum(len(slide["warnings"]) for slide in report["slides"])
    summary = {
        "output": str(manifest.output),
        "report": str(manifest.report),
        "slidesCreated": report["contentSlideCount"],
        "blankSlides": report["blankTicketCount"],
        "warnings": warning_count,
        "slideCount": report["slideCount"],
        "contentSlideCount": report["contentSlideCount"],
        "blankTicketCount": report["blankTicketCount"],
        "videoCount": report["videoCount"],
        "uniqueMediaAdded": report["uniqueMediaAdded"],
        "warningCount": warning_count,
    }
    _emit("completed", summary=summary)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.command == "build-manifest":
            return _build_manifest(args.manifest)
        parser.error(f"Unknown command: {args.command}")
    except Cancelled as exc:
        _emit("cancelled", message=str(exc))
        return CANCELLED_EXIT_CODE
    except (ManifestError, BuildError, OSError, RuntimeError) as exc:
        _emit("log", level="error", message=str(exc))
        print(f"Error: {exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
