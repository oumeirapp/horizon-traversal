# PDFium native-library notice

Horizon Traversal bundles the Apple Silicon PDFium shared library described below.
The Python modules from the wheel are not bundled.

- PDFium version: `151.0.7920.0`
- Binary origin: `pdfium-binaries`
- Distribution package: `pypdfium2 5.11.0`
- Wheel: `pypdfium2-5.11.0-py3-none-macosx_12_0_arm64.whl`
- Wheel URL: <https://files.pythonhosted.org/packages/d2/13/13571dc7f1d11a4e4bde6ab8961318b04ff70bdc2aea5e7f88be5ef53167/pypdfium2-5.11.0-py3-none-macosx_12_0_arm64.whl>
- Wheel SHA-256: `73fe55dd258f02332bc0a34128ddc2994fd610e664d1f2f7d78dd9e2570f15ee`
- `libpdfium.dylib` SHA-256: `df568fcd17a6a6296956aa79abea1181db187458432f360b084fec1cea7cd4d9`
- Upstream binary project: <https://github.com/bblanchon/pdfium-binaries>
- PDFium source: <https://pdfium.googlesource.com/pdfium/>

PDFium is distributed under a BSD-style license and includes components under
other open-source licenses. The `wheel/` directory beside this notice is an
unmodified copy of every file declared as `License-File` by this exact wheel.
It contains the PDFium license, the `pdfium-binaries` license, and all licenses
reported for the dependencies linked into this build. These files must remain
with every distributed copy of the library.

The complete expected file list and SHA-256 values are recorded in
`native-assets.json`, which is bundled with the application and verified before
packaging.
