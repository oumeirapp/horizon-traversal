# PowerPoint sidecar license inventory

This directory is bundled with Horizon Traversal under
`powerpoint/licenses`. Except for this inventory, every file is copied
byte-for-byte from an authoritative Python source release or from the exact
package artifact named below.

The release build uses Python 3.11.9 and the exact versions in
`../requirements-bundle.txt`. Platform-specific entries are retained together
so either supported installer carries the complete cross-platform inventory.

| Component | Authoritative license source |
| --- | --- |
| Python 3.11.9 | CPython `v3.11.9/LICENSE` (`3b2f81fe21d181c499c59a256c8e1968455d6689d269aa85373bfb6af41da3bf`) |
| altgraph 0.17.4 | `altgraph-0.17.4-py2.py3-none-any.whl` (`642743b4750de17e655e6711601b077bc6598dbfa3ba5fa2b2a35ce12b508dff`) |
| defusedxml 0.7.1 | `defusedxml-0.7.1-py2.py3-none-any.whl` (`a352e7e428770286cc899e2542b6cdaedb2b4953ff269a210103ec58f6198a61`) |
| macholib 1.16.3 | `macholib-1.16.3-py2.py3-none-any.whl` (`0e315d7583d38b8c77e815b1ecbdbf504a8258d8b3e17b61165c6feb60d18f2c`) |
| packaging 25.0 | `packaging-25.0-py3-none-any.whl` (`29572ef2b1f17581046b3a2227d5c611fb25ec70ca1ba8554b24b0e69331a484`) |
| pefile 2023.2.7 | `pefile-2023.2.7-py3-none-any.whl` (`da185cd2af68c08a6cd4481f7325ed600a88f6a813bad9dea07ab3ef73d8d8d6`) |
| Pillow 11.3.0 | macOS arm64 CPython 3.11 wheel (`9c412fddd1b77a75aa904615ebaa6001f169b26fd467b4be93aded278266b288`) and Windows x64 CPython 3.11 wheel (`1a992e86b0dd7aeb1f053cd506508c0999d710a8f07b4c791c63843fc6a807ac`) |
| PyInstaller 6.16.0 | macOS universal2 wheel (`7fd1c785219a87ca747c21fa92f561b0d2926a7edc06d0a0fe37f3736e00bd7a`) and Windows x64 wheel (`bc10eb1a787f99fea613509f55b902fbd2d8b73ff5f51ff245ea29a481d97d41`) |
| PyInstaller hooks contrib 2025.9 | `pyinstaller_hooks_contrib-2025.9-py3-none-any.whl` (`ccbfaa49399ef6b18486a165810155e5a8d4c59b41f20dc5da81af7482aaf038`) |
| pywin32-ctypes 0.2.3 | `pywin32_ctypes-0.2.3-py3-none-any.whl` (`8a1513379d709975552d202d942d9837758905c8d01eb82b8bcc30918929e7b8`) |
| setuptools 80.9.0 and its vendored packages | `setuptools-80.9.0-py3-none-any.whl` (`062d34222ad13e0cc312a4c02d73f059e86a4acbfbdea8f8f76b28c99f306922`) |
| modulegraph 0.17 vendored by PyInstaller | `modulegraph-0.17.tar.gz` (`d2824588c489c0ba6f815c066950400755e8e287da64bcddae4c0d6e76f8f5f3`) |

`Pillow-11.3.0/LICENSE` is the complete license file shipped in both pinned
Pillow wheels. In addition to Pillow itself, it contains the notices for the
native image libraries included by those wheels, including AOM/libavif,
Brotli, FreeType, HarfBuzz, JPEG, LCMS2, liblzma/XZ, OpenJPEG, libpng, TIFF,
WebP, Xau/XCB, and zlib-ng.

`PyInstaller-6.16.0/COPYING.txt` includes the bootloader exception and the full
applicable GPL and Apache license texts. Its bundled modulegraph provenance is
preserved in `PyInstaller-6.16.0/VENDORED-LIBRARIES.rst`.
