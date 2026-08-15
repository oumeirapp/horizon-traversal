# PowerPoint sidecar third-party notices

The frozen `powerpoint-sidecar` is built with Python 3.11.9 and the exact
package versions recorded in `requirements-bundle.txt`. The complete,
verbatim license inventory is bundled beside this notice under
`powerpoint/licenses/` and indexed by `powerpoint/licenses/README.md`.

## Frozen runtime

- Python 3.11.9 — Python Software Foundation License Version 2 and applicable
  historical licenses.
- defusedxml 0.7.1 — Python Software Foundation License Version 2.
- Pillow 11.3.0 — MIT-CMU license. Its packaged license also contains the
  complete notices for the native image libraries embedded by the pinned
  macOS arm64 and Windows x64 wheels.
- PyInstaller 6.16.0 bootloader and runtime files — GPL-2.0-or-later with the
  PyInstaller bootloader exception, plus Apache-2.0 runtime-hook terms.
- setuptools 80.9.0 runtime support selected by PyInstaller, including its
  vendored packages — licenses are preserved individually in the license tree.

## Frozen-build components

- altgraph 0.17.4 — MIT.
- macholib 1.16.3 — MIT; macOS build only.
- modulegraph 0.17 vendored by PyInstaller — MIT.
- packaging 25.0 — Apache-2.0 or BSD-2-Clause.
- pefile 2023.2.7 — MIT; Windows build only.
- pyinstaller-hooks-contrib 2025.9 — Apache-2.0 or GPL-2.0-or-later.
- pywin32-ctypes 0.2.3 — BSD-3-Clause; Windows build only.

## Template and user content

`resources/Slide template.pptx` is an application-provided Horizon template,
not a third-party library. Source images, posters, and videos remain the user's
content; the sidecar embeds them without changing their ownership or license.
