import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import extract from "extract-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PDFIUM_VERSION = "151.0.7920.0";
const WHEEL_URL =
  "https://files.pythonhosted.org/packages/d2/13/13571dc7f1d11a4e4bde6ab8961318b04ff70bdc2aea5e7f88be5ef53167/pypdfium2-5.11.0-py3-none-macosx_12_0_arm64.whl";
const WHEEL_SHA256 =
  "73fe55dd258f02332bc0a34128ddc2994fd610e664d1f2f7d78dd9e2570f15ee";
const LIBRARY_SHA256 =
  "df568fcd17a6a6296956aa79abea1181db187458432f360b084fec1cea7cd4d9";
const DESTINATION = path.join(
  ROOT,
  "src-tauri",
  "resources",
  "native",
  "libpdfium.dylib",
);

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error(
    `PDFium ${PDFIUM_VERSION} preparation currently supports macOS arm64; received ${process.platform}-${process.arch}`,
  );
}

if ((await fileExists(DESTINATION)) && (await sha256(DESTINATION)) === LIBRARY_SHA256) {
  console.log(`PDFium ${PDFIUM_VERSION} is already prepared.`);
  process.exit(0);
}

const temporaryDirectory = await mkdtemp(
  path.join(tmpdir(), "x-traversal-pdfium-"),
);

try {
  const wheel = path.join(temporaryDirectory, "pdfium.whl");
  const response = await fetch(WHEEL_URL);
  if (!response.ok) {
    throw new Error(`PDFium download failed: HTTP ${response.status}`);
  }
  await writeFile(wheel, Buffer.from(await response.arrayBuffer()));

  const wheelHash = await sha256(wheel);
  if (wheelHash !== WHEEL_SHA256) {
    throw new Error(
      `PDFium wheel checksum mismatch: expected ${WHEEL_SHA256}, received ${wheelHash}`,
    );
  }

  const extracted = path.join(temporaryDirectory, "extracted");
  await mkdir(extracted);
  await extract(wheel, { dir: extracted });

  const rawDirectory = path.join(extracted, "pypdfium2_raw");
  const version = JSON.parse(
    await readFile(path.join(rawDirectory, "version.json"), "utf8"),
  );
  const extractedVersion = [
    version.major,
    version.minor,
    version.build,
    version.patch,
  ].join(".");
  if (extractedVersion !== PDFIUM_VERSION) {
    throw new Error(
      `PDFium version mismatch: expected ${PDFIUM_VERSION}, received ${extractedVersion}`,
    );
  }

  const library = path.join(rawDirectory, "libpdfium.dylib");
  const libraryHash = await sha256(library);
  if (libraryHash !== LIBRARY_SHA256) {
    throw new Error(
      `PDFium library checksum mismatch: expected ${LIBRARY_SHA256}, received ${libraryHash}`,
    );
  }

  await mkdir(path.dirname(DESTINATION), { recursive: true });
  await copyFile(library, DESTINATION);
  console.log(`Prepared PDFium ${PDFIUM_VERSION} at ${DESTINATION}`);
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
