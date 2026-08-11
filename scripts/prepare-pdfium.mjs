import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
const MANIFEST_PATH = path.join(ROOT, "src-tauri", "native-assets.json");

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`could not run ${program}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `${program} ${args.join(" ")} exited with status ${result.status}${
        output ? `: ${output}` : ""
      }`,
    );
  }

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function detectHostTriple() {
  const rustcVersion = run("rustc", ["-vV"]);
  const hostTriple = /^host:\s*(\S+)\s*$/m.exec(rustcVersion)?.[1];
  if (!hostTriple) {
    throw new Error("rustc -vV did not report a host target triple");
  }
  return hostTriple;
}

async function sha256(file) {
  const hash = createHash("sha256");
  hash.update(await readFile(file));
  return hash.digest("hex");
}

async function fileExists(file) {
  try {
    return (await stat(file)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function resolveTarget(manifest, hostTriple) {
  if (manifest.schemaVersion !== 2) {
    throw new Error(
      `unsupported native asset manifest schema: ${manifest.schemaVersion}`,
    );
  }
  if (!manifest.pinnedTargets?.includes(hostTriple)) {
    throw new Error(
      `PDFium preparation does not support rustc host ${hostTriple}; available targets: ${(manifest.pinnedTargets ?? []).join(", ")}`,
    );
  }

  const target = manifest.targets?.[hostTriple];
  const wheel = manifest.sources?.pdfiumWheels?.[hostTriple];
  if (!target || !wheel) {
    throw new Error(`PDFium pins are incomplete for rustc host ${hostTriple}`);
  }
  if (target.pdfium?.version !== wheel.pdfiumVersion) {
    throw new Error(
      `PDFium target version ${target.pdfium?.version} does not match wheel version ${wheel.pdfiumVersion}`,
    );
  }

  const libraryName =
    target.platform === "darwin"
      ? "libpdfium.dylib"
      : target.platform === "windows"
        ? "pdfium.dll"
        : undefined;
  if (!libraryName) {
    throw new Error(
      `PDFium preparation does not support target platform ${target.platform}`,
    );
  }

  const expectedPath = `src-tauri/resources/native/${libraryName}`;
  if (target.pdfium.path !== expectedPath) {
    throw new Error(
      `PDFium target ${hostTriple} must install to ${expectedPath}; received ${target.pdfium.path}`,
    );
  }

  return {
    destination: path.join(ROOT, ...expectedPath.split("/")),
    libraryName,
    librarySha256: target.pdfium.sha256,
    version: wheel.pdfiumVersion,
    wheelSha256: wheel.sha256,
    wheelUrl: wheel.url,
  };
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const hostTriple = detectHostTriple();
  const target = resolveTarget(manifest, hostTriple);

  if (
    (await fileExists(target.destination)) &&
    (await sha256(target.destination)) === target.librarySha256
  ) {
    console.log(`PDFium ${target.version} is already prepared for ${hostTriple}.`);
    return;
  }

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "horizon-traversal-pdfium-"),
  );

  try {
    const wheel = path.join(temporaryDirectory, "pdfium.whl");
    const response = await fetch(target.wheelUrl, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(`PDFium download failed: HTTP ${response.status}`);
    }
    if (new URL(response.url).protocol !== "https:") {
      throw new Error(`PDFium download redirected away from HTTPS: ${response.url}`);
    }
    await writeFile(wheel, Buffer.from(await response.arrayBuffer()));

    const wheelHash = await sha256(wheel);
    if (wheelHash !== target.wheelSha256) {
      throw new Error(
        `PDFium wheel checksum mismatch: expected ${target.wheelSha256}, received ${wheelHash}`,
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
    if (extractedVersion !== target.version) {
      throw new Error(
        `PDFium version mismatch: expected ${target.version}, received ${extractedVersion}`,
      );
    }

    const library = path.join(rawDirectory, target.libraryName);
    const libraryHash = await sha256(library);
    if (libraryHash !== target.librarySha256) {
      throw new Error(
        `PDFium library checksum mismatch: expected ${target.librarySha256}, received ${libraryHash}`,
      );
    }

    await mkdir(path.dirname(target.destination), { recursive: true });
    await copyFile(library, target.destination);
    const installedHash = await sha256(target.destination);
    if (installedHash !== target.librarySha256) {
      throw new Error(
        `installed PDFium checksum mismatch: expected ${target.librarySha256}, received ${installedHash}`,
      );
    }
    console.log(
      `Prepared PDFium ${target.version} for ${hostTriple} at ${target.destination}`,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`PDFium preparation failed: ${error.message}`);
  process.exitCode = 1;
});
