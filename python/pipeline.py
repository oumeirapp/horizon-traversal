import shutil
from pathlib import Path
import re
import os
from datetime import datetime
from dataclasses import dataclass
from enum import Enum
from PIL import Image
import pypdfium2 as pdfium
import sys

import subprocess


def resource_path(name: str) -> Path:
    base = Path(getattr(sys, "_MEIPASS", Path(__file__).parent))
    return base / name


def get_binary(name: str) -> str:
    # bundled app
    if getattr(sys, "frozen", False):
        path = resource_path(name)
        if not path.exists():
            raise FileNotFoundError(f"Bundled binary not found: {path}")
        return str(path)

    # dev mode
    import shutil
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"{name} not found in PATH (install ffmpeg)")
    return path


FFMPEG = get_binary("ffmpeg")
FFPROBE = get_binary("ffprobe")

# decompression bomb protection
Image.MAX_IMAGE_PIXELS = None

# Matches version patterns like: v1, ver1, version1, ver 1, version 1, Ver_2, etc.
VERSION_PATTERN = re.compile(r'v(?:er(?:sion)?)?\s*[_\-]?\s*(\d+)', re.IGNORECASE)

EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".pdf", ".mp4", ".avi", ".mov"}


# ═════════════════════════════════════════════════════════════
#  Structured logging
# ═════════════════════════════════════════════════════════════

class LogType(Enum):
    INFO    = "INFO"
    SUCCESS = "SUCCESS"
    WARNING = "WARNING"
    ERROR   = "ERROR"


@dataclass
class LogEntry:
    timestamp: datetime
    level: LogType
    message: str


# Sink receives LogEntry objects. If None, entries are printed to stdout only.
_log_sink = None


def set_log_sink(fn):
    """Register a callback fn(entry: LogEntry) to receive all log output."""
    global _log_sink
    _log_sink = fn


def _emit(level: LogType, message: str):
    """Create a LogEntry, print it, and forward to the UI sink."""
    entry = LogEntry(timestamp=datetime.now(), level=level, message=message)
    ts = entry.timestamp.strftime("%H:%M:%S")
    print(f"{ts}  {level.value:<8}  {message}")
    if _log_sink:
        _log_sink(entry)


# Convenience wrappers
def _info(msg: str):    _emit(LogType.INFO,    msg)
def _ok(msg: str):      _emit(LogType.SUCCESS, msg)
def _warn(msg: str):    _emit(LogType.WARNING, msg)
def _err(msg: str):     _emit(LogType.ERROR,   msg)


# ═════════════════════════════════════════════════════════════
#  Helpers
# ═════════════════════════════════════════════════════════════

def normalize(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


def find_source_folders(ticket_root: Path) -> list[Path]:
    """Find all Master Files / Deliverables folders inside a ticket."""
    matches = []
    for path in ticket_root.rglob("*"):
        if not path.is_dir():
            continue
        name = normalize(path.name)
        if "masterfiles" in name or "deliverables" in name:
            matches.append(path)
    return matches


def safe_copy(src: Path, dest_dir: Path) -> Path:
    """Copy src into dest_dir with incremental suffix on collision."""
    dest = dest_dir / src.name
    counter = 1
    while dest.exists():
        dest = dest_dir / f"{src.stem}_{counter}{src.suffix}"
        counter += 1
    shutil.copy2(src, dest)
    return dest


# ═════════════════════════════════════════════════════════════
#  Traversal
# ═════════════════════════════════════════════════════════════

def collect_recursive(
    current_dir: Path,
    dest_dir: Path,
    extensions: set[str],
    inside_version: bool = False,
    traversal_root: Path | None = None,
    copied_files: list[Path] | None = None,
) -> int:
    """
    Recursively collect files from current_dir into dest_dir (flat).
    Returns the number of files copied.
    """
    if traversal_root is None:
        traversal_root = current_dir

    copied = 0
    version_folders: dict[int, Path] = {}

    for item in current_dir.iterdir():

        if item.is_file() and item.suffix.lower() in extensions:
            if item.suffix.lower() == ".mov":
                _warn(f"Skipped .mov file (not supported): {item.name}")
                continue

            dest = safe_copy(item, dest_dir)
            if copied_files is not None:
                copied_files.append(item.resolve())
            _ok(f"Copied  {item.name}")
            copied += 1

        elif item.is_dir() and not inside_version:
            match = VERSION_PATTERN.search(item.name)
            if match:
                version_num = int(match.group(1))
                rel = item.relative_to(traversal_root.parent)
                _info(f"Version folder detected: {rel}  (v{version_num})")
                version_folders[version_num] = item

    if version_folders and not inside_version:
        latest_num = max(version_folders)
        latest_folder = version_folders[latest_num]
        _ok(f"Latest version selected: {latest_folder.name}")
        copied += collect_recursive(
            latest_folder, 
            dest_dir, 
            extensions,
            inside_version=True, 
            traversal_root=traversal_root,
            copied_files=copied_files,
        )
    else:
        for item in current_dir.iterdir():
            if item.is_dir():
                if not inside_version and VERSION_PATTERN.search(item.name):
                    continue
                copied += collect_recursive(
                    item, 
                    dest_dir, 
                    extensions,
                    inside_version, 
                    traversal_root,
                    copied_files,
                )

    return copied


# ═════════════════════════════════════════════════════════════
#  PDF conversion
# ═════════════════════════════════════════════════════════════

def convert_pdfs(folder: Path, scale: int = 2, remove_pdf: bool = True):
    _info("Converting PDFs...")
    count = 0

    for pdf_file in folder.iterdir():
        if not (pdf_file.is_file() and pdf_file.suffix.lower() == ".pdf"):
            continue
        try:
            pdf = pdfium.PdfDocument(pdf_file)
            page = pdf[0]
            bitmap = page.render(scale=scale)
            img = bitmap.to_pil()

            output_path = pdf_file.with_suffix(".png")
            img.save(output_path)
            pdf.close()

            _ok(f"PDF converted: {pdf_file.name}")
            count += 1

            if remove_pdf:
                pdf_file.unlink()
                _info(f"Removed original PDF: {pdf_file.name}")

        except Exception as e:
            _err(f"Failed to convert PDF {pdf_file.name}: {e}")

    _info(f"PDFs converted: {count}")


# ═════════════════════════════════════════════════════════════
#  Image resizing
# ═════════════════════════════════════════════════════════════

def resize_images(folder: Path, quality: int = 70):
    _info("Resizing images...")
    MAX_SIZE = (1920, 1080)
    image_extensions = {".jpg", ".jpeg", ".png"}
    count = 0

    for image_file in folder.iterdir():
        if not (image_file.is_file() and image_file.suffix.lower() in image_extensions):
            continue
        try:
            with Image.open(image_file) as img:
                orig_w, orig_h = img.width, img.height
                if orig_w > 1920 or orig_h > 1080:
                    img.thumbnail(MAX_SIZE, Image.Resampling.LANCZOS)
                    img.save(image_file, optimize=True, quality=quality)
                    _ok(f"Image resized: {image_file.name}  ({orig_w}×{orig_h}  →  {img.width}×{img.height})")
                else:
                    _info(f"Image within bounds, skipped: {image_file.name}  ({orig_w}×{orig_h})")
            count += 1
        except Exception as e:
            _err(f"Failed to resize image {image_file.name}: {e}")

    _info(f"Images processed: {count}")


# ═════════════════════════════════════════════════════════════
#  Video helpers
# ═════════════════════════════════════════════════════════════

HD_LONG  = 1280
HD_SHORT = 720


def probe_video(path: str) -> dict:
    cmd = [
        FFPROBE,
        "-v", "error",
        "-print_format", "json",
        "-show_streams",
        "-show_format",
        path
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    import json
    info = json.loads(result.stdout)

    video_streams = [s for s in info["streams"] if s["codec_type"] == "video"]
    audio_streams = [s for s in info["streams"] if s["codec_type"] == "audio"]
    if not video_streams:
        raise RuntimeError("No video stream found")

    stream = video_streams[0]

    width = int(stream["width"])
    height = int(stream["height"])
    duration = float(info["format"].get("duration", 0))

    return {
        "width": width,
        "height": height,
        "duration": duration,
        "audio_streams": len(audio_streams),
    }


def compute_target_dimensions(width: int, height: int) -> tuple | None:
    """
    Return (target_w, target_h) scaled down to HD_LONG×HD_SHORT,
    or None if the video is already within HD bounds (no upscaling).
    """
    is_landscape = width >= height
    long_side, short_side = (width, height) if is_landscape else (height, width)

    if long_side <= HD_LONG and short_side <= HD_SHORT:
        return None

    scale_factor = HD_LONG / long_side
    new_short    = short_side * scale_factor

    new_long  = HD_LONG
    new_short = new_short if new_short >= HD_SHORT else HD_SHORT

    # Enforce even pixel counts (required by H.264)
    new_long  = (int(new_long)  // 2) * 2
    new_short = (int(new_short) // 2) * 2

    return (new_long, new_short) if is_landscape else (new_short, new_long)



def _ffmpeg_resize_video(
    input_path: str,
    output_path: str,
    w: int,
    h: int,
    has_audio: bool,
):
    suffix = Path(output_path).suffix.lower()
    audio_args = []
    if has_audio:
        audio_args = (
            ["-c:a", "aac", "-b:a", "192k"]
            if suffix in {".mp4", ".mov"}
            else ["-c:a", "copy"]
        )

    cmd = [
        FFMPEG,
        "-y",
        "-i", input_path,
        "-map", "0:v:0",
        "-map", "0:a?",
        "-vf", f"scale={w}:{h}",
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        *audio_args,
        output_path
    ]

    subprocess.run(cmd, check=True)


def human_size(path: str) -> str:
    """Return a human-readable file size string (e.g. '24.3 MB')."""
    size = os.path.getsize(path)
    for unit in ("B", "KB", "MB", "GB"):
        if size < 1024:
            return f"{size:.1f} {unit}"
        size /= 1024
    return f"{size:.1f} TB"


# ═════════════════════════════════════════════════════════════
#  Video resizing
# ═════════════════════════════════════════════════════════════

def resize_videos(folder: Path):
    _info("Resizing videos...")
    video_extensions = {".mp4", ".avi"}
    count = 0

    for video_file in folder.iterdir():
        if not (video_file.is_file() and video_file.suffix.lower() in video_extensions):
            continue

        try:
            meta = probe_video(str(video_file))
            w, h = meta["width"], meta["height"]

            target = compute_target_dimensions(w, h)

            if target is None:
                _info(f"Video within HD bounds, skipped: {video_file.name} ({w}×{h})")
                continue

            tw, th = target

            tmp_path = video_file.with_stem(video_file.stem + "_tmp")

            _ffmpeg_resize_video(
                str(video_file),
                str(tmp_path),
                tw,
                th,
                meta["audio_streams"] > 0,
            )

            resized_meta = probe_video(str(tmp_path))
            if meta["audio_streams"] > 0 and resized_meta["audio_streams"] == 0:
                tmp_path.unlink(missing_ok=True)
                raise RuntimeError("Resized file is missing the original audio track")

            size_before = human_size(str(video_file))
            video_file.unlink()
            tmp_path.rename(video_file)
            size_after = human_size(str(video_file))

            _ok(
                f"Video resized: {video_file.name} "
                f"({w}×{h} → {tw}×{th}) "
                f"{size_before} → {size_after}"
            )

            count += 1

        except Exception as e:
            _err(f"Failed to resize video {video_file.name}: {e}")

    _info(f"Videos resized: {count}")
# ═════════════════════════════════════════════════════════════
#  Main entry point
# ═════════════════════════════════════════════════════════════

def process_all(root: str = "../", output_dir: str = "./output", folders: list[str] | None = None):
    root_path   = Path(root)
    output_root = Path(output_dir)
    copied_files: list[Path] = []

    if folders is not None:
        # Use the explicit list passed in from the UI (already filtered by app.py)
        ticket_folders = sorted([Path(f) for f in folders], key=lambda p: p.name)
    else:
        # CLI / default behaviour — scan the entire root directory
        ticket_folders = sorted([p for p in root_path.iterdir() if p.is_dir()])

    _info(f"PIPELINE START — {len(ticket_folders)} ticket(s) to process")
    _info(f"Input:  {root_path.resolve()}")
    _info(f"Output: {output_root.resolve()}")

    for ticket_folder in ticket_folders:
        _info(f"── TICKET: {ticket_folder.name} ──")

        ticket_output = output_root / ticket_folder.name
        if ticket_output.exists():
            shutil.rmtree(ticket_output)
        ticket_output.mkdir(parents=True, exist_ok=True)
        _info(f"Output directory: {ticket_output.resolve()}")

        total_copied = 0

        try:
            # ── 1. COLLECT FILES ──────────────────────────────────
            _info("Scanning for source folders...")
            source_folders = find_source_folders(ticket_folder)

            if not source_folders:
                _warn(f"No 'Master Files' or 'Deliverables' folders found in {ticket_folder.name} — skipping.")
                continue

            for source_dir in source_folders:
                _info(f"Traversing deliverables: {source_dir.relative_to(ticket_folder)}")
                total_copied += collect_recursive(
                    source_dir, 
                    ticket_output, 
                    EXTENSIONS,
                    traversal_root=source_dir,
                    copied_files=copied_files,
                )

            _ok(f"Total files copied: {total_copied}")

            # ── 2. CONVERT PDFs ───────────────────────────────────
            convert_pdfs(ticket_output)

            # ── 3. RESIZE IMAGES ──────────────────────────────────
            resize_images(ticket_output)

            # ── 4. RESIZE VIDEOS ──────────────────────────────────
            resize_videos(ticket_output)

            report_path = ticket_output / "report.txt"

            with report_path.open("w", encoding="utf-8") as f:
                for path in copied_files:
                    f.write(f"{path}\n")

            _ok(f"Report created: {report_path.name}")


            _ok(f"Ticket completed: {ticket_folder.name}")
            _info(f"Output directory: {ticket_output.resolve()}")

        except Exception as e:
            _err(f"Unexpected error processing ticket {ticket_folder.name}: {e}")
            _warn("Skipping to next ticket.")

    _ok("Pipeline completed successfully")
    _info(f"Total tickets processed: {len(ticket_folders)}")


if __name__ == "__main__":
    process_all()
