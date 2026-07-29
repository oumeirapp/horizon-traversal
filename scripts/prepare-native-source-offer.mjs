import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "dist", "native-source-offer");
const MANIFEST_PATH = path.join(ROOT, "src-tauri", "native-assets.json");

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function downloadVerified(source, destination) {
  const result = spawnSync(
    "curl",
    [
      "--fail",
      "--location",
      "--proto",
      "=https",
      "--retry",
      "3",
      "--show-error",
      "--silent",
      "--tlsv1.2",
      "--output",
      destination,
      source.url,
    ],
    { encoding: "utf8", windowsHide: true },
  );
  if (result.error) {
    throw new Error(`could not run curl: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `download failed for ${source.url}: ${result.stderr.trim() || `curl status ${result.status}`}`,
    );
  }
  const contents = await readFile(destination);
  const digest = sha256(contents);
  if (digest !== source.sha256) {
    throw new Error(
      `checksum mismatch for ${source.url}: expected ${source.sha256}, received ${digest}`,
    );
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const sources = [manifest.sources?.ffmpeg, manifest.sources?.x264];
  if (
    sources.some(
      (source) =>
        typeof source?.url !== "string" ||
        !/^[a-f0-9]{64}$/.test(source?.sha256 ?? ""),
    )
  ) {
    throw new Error("native-assets.json does not contain valid FFmpeg/x264 sources");
  }

  await rm(OUTPUT, { recursive: true, force: true });
  await mkdir(OUTPUT, { recursive: true });

  const outputFiles = [];
  for (const source of sources) {
    const fileName = new URL(source.url).pathname.split("/").at(-1);
    if (!fileName || fileName === "." || fileName === "..") {
      throw new Error(`source URL has no safe file name: ${source.url}`);
    }
    const destination = path.join(OUTPUT, fileName);
    await downloadVerified(source, destination);
    outputFiles.push(destination);
  }

  const supportingFiles = [
    "scripts/build-native-macos-arm64.sh",
    "src-tauri/native-assets.json",
    "src-tauri/binaries/README.md",
    "src-tauri/binaries/THIRD_PARTY_NOTICES.md",
    "src-tauri/binaries/licenses/GPL-2.0-or-later.txt",
  ];
  for (const relativePath of supportingFiles) {
    const destination = path.join(OUTPUT, path.basename(relativePath));
    await copyFile(path.join(ROOT, relativePath), destination);
    outputFiles.push(destination);
  }

  const checksums = [];
  for (const file of outputFiles.sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right)),
  )) {
    checksums.push(`${sha256(await readFile(file))}  ${path.basename(file)}`);
  }
  await writeFile(path.join(OUTPUT, "SHA256SUMS"), `${checksums.join("\n")}\n`, {
    mode: 0o644,
  });

  console.log(`Prepared complete corresponding source at ${OUTPUT}`);
}

main().catch((error) => {
  console.error(`Native source-offer preparation failed: ${error.message}`);
  process.exitCode = 1;
});
