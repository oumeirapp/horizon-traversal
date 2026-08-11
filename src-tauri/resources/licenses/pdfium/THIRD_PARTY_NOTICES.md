# PDFium native-library notice

Horizon Traversal bundles target-specific PDFium shared libraries from the
Python wheels described below. The Python modules from the wheels are not
bundled.

- PDFium version: `151.0.7920.0`
- Binary origin: `pdfium-binaries`
- Distribution package: `pypdfium2 5.11.0`

## Apple Silicon macOS

- Wheel: `pypdfium2-5.11.0-py3-none-macosx_12_0_arm64.whl`
- Wheel URL: <https://files.pythonhosted.org/packages/d2/13/13571dc7f1d11a4e4bde6ab8961318b04ff70bdc2aea5e7f88be5ef53167/pypdfium2-5.11.0-py3-none-macosx_12_0_arm64.whl>
- Wheel SHA-256: `73fe55dd258f02332bc0a34128ddc2994fd610e664d1f2f7d78dd9e2570f15ee`
- `libpdfium.dylib` SHA-256: `df568fcd17a6a6296956aa79abea1181db187458432f360b084fec1cea7cd4d9`

## x86-64 Windows

- Wheel: `pypdfium2-5.11.0-py3-none-win_amd64.whl`
- Wheel URL: <https://files.pythonhosted.org/packages/73/d4/8b8af6eedbc5c8af49817d8f37c2e55be8a2c7f75fca9bee78efbfeb40f6/pypdfium2-5.11.0-py3-none-win_amd64.whl>
- Wheel SHA-256: `d3b698e7b51bdf2d633cc834395677319e1d66757896b30c632dfac7d7236c81`
- `pdfium.dll` SHA-256: `0aa3abb1aa20798094c1a5f2d8cdea45b24a6e12cdc6c774de261dd522dbdf81`

## Upstream and licenses

- Upstream binary project: <https://github.com/bblanchon/pdfium-binaries>
- PDFium source: <https://pdfium.googlesource.com/pdfium/>

PDFium is distributed under a BSD-style license and includes components under
other open-source licenses. The `wheel/` directory beside this notice contains
unmodified copies of every file declared as `License-File` by the pinned
wheels. Shared license texts are stored once under `LICENSES/`; target-specific
build licenses are stored under `data/darwin_arm64/` and `data/windows_x64/`.
They include the PDFium license, the `pdfium-binaries` license, and all licenses
reported for dependencies linked into each build. These files must remain with
every distributed copy of the corresponding library.

The complete expected file list and SHA-256 values are recorded in
`native-assets.json`, which is bundled with the application and verified before
packaging.
