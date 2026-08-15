# -*- mode: python ; coding: utf-8 -*-

from pathlib import Path


root = Path(SPECPATH)
analysis = Analysis(
    [str(root / "pyinstaller_entry.py")],
    pathex=[str(root / "src")],
    binaries=[],
    # The template is a separately verified Tauri resource. Keeping it out of
    # the executable avoids shipping the same 2.3 MB file twice.
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
)
python_archive = PYZ(analysis.pure)
executable = EXE(
    python_archive,
    analysis.scripts,
    analysis.binaries,
    analysis.datas,
    [],
    name="powerpoint-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
