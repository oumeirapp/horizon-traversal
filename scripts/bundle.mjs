import { spawn, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertBundleEnvironment,
  bundleEnvironment,
  resolveBundleTarget,
} from "./lib/bundle-targets.mjs";
import { assembleDistribution } from "./lib/distribution-package.mjs";
import {
  verifyDeterministicSourceOfferZip,
  verifyNativeSourceOffer,
} from "./lib/native-source-offer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CLI = path.join(
  ROOT,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

function rustHostTriple() {
  const result = spawnSync("rustc", ["-vV"], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`could not run rustc: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    throw new Error(
      `rustc -vV exited with status ${result.status}${output ? `: ${output}` : ""}`,
    );
  }
  const host = /^host:\s*(\S+)\s*$/m.exec(result.stdout)?.[1];
  if (!host) {
    throw new Error("rustc -vV did not report a host target triple");
  }
  return host;
}

function run(program, arguments_, environment = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, arguments_, {
      cwd: ROOT,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${path.basename(program)} was terminated by ${signal}`
            : `${path.basename(program)} exited with status ${code}`,
        ),
      );
    });
  });
}

async function prepareNativeAssets() {
  for (const script of [
    "prepare-pdfium.mjs",
    "prepare-ffmpeg.mjs",
    "verify-native-assets.mjs",
  ]) {
    await run(process.execPath, [path.join(ROOT, "scripts", script)]);
  }
}

async function prepareAndVerifySourceOffer(cargoTargetDirectory) {
  const releaseDirectory = path.join(
    cargoTargetDirectory,
    "release-artifacts",
  );
  const offerDirectory = path.join(releaseDirectory, "native-source-offer");
  const archivePath = path.join(
    releaseDirectory,
    "Horizon-Traversal-native-source.zip",
  );
  try {
    const offer = await verifyNativeSourceOffer({
      root: ROOT,
      offerDirectory,
    });
    const archive = await verifyDeterministicSourceOfferZip({
      offerDirectory,
      archivePath,
    });
    console.log(
      `Using verified corresponding source (${offer.fileCount} files, SHA-256 ${archive.sha256}).`,
    );
    return;
  } catch {
    // A clean checkout has no source offer. Prepare it from the pinned sources,
    // then run the independent verifier before assembling a distribution.
  }
  for (const script of [
    "prepare-native-source-offer.mjs",
    "verify-native-source-offer.mjs",
  ]) {
    await run(process.execPath, [path.join(ROOT, "scripts", script)]);
  }
}

async function finishMacosBundle(cargoTargetDirectory) {
  const releaseBundle = path.join(
    cargoTargetDirectory,
    "aarch64-apple-darwin",
    "release",
    "bundle",
  );
  const applications = (await readdir(path.join(releaseBundle, "macos")))
    .filter((entry) => entry.endsWith(".app"));
  const diskImages = (await readdir(path.join(releaseBundle, "dmg")))
    .filter((entry) => entry.endsWith(".dmg"));
  if (applications.length !== 1 || diskImages.length !== 1) {
    throw new Error(
      `expected one macOS application and one disk image; found ${applications.length} app(s) and ${diskImages.length} DMG(s)`,
    );
  }

  const application = path.join(releaseBundle, "macos", applications[0]);
  const diskImage = path.join(releaseBundle, "dmg", diskImages[0]);
  await run("/usr/bin/codesign", [
    "--force",
    "--sign",
    "-",
    "--timestamp=none",
    diskImage,
  ]);
  await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    "--verbose=2",
    application,
  ]);
  await run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--verbose=2",
    diskImage,
  ]);
}

async function main() {
  const name = process.argv[2];
  resolveBundleTarget(name);
  const target = assertBundleEnvironment(name, {
    platform: process.platform,
    architecture: process.arch,
    rustHost: rustHostTriple(),
    nodeVersion: process.versions.node,
  });

  await prepareNativeAssets();
  const cargoTargetDirectory = path.join(ROOT, "src-tauri", "target");
  await run(
    process.execPath,
    [TAURI_CLI, ...target.tauriArguments],
    bundleEnvironment(name, process.env, cargoTargetDirectory),
  );
  if (name === "macos") {
    // Tauri signs nested code and the app with the ad-hoc identity. Tauri
    // intentionally skips self-signing DMGs, so sign that final container here.
    await finishMacosBundle(cargoTargetDirectory);
  }
  await prepareAndVerifySourceOffer(cargoTargetDirectory);
  const distribution = await assembleDistribution({
    root: ROOT,
    targetName: name,
    cargoTargetDirectory,
  });
  console.log(
    `Prepared ${name} distribution with ${distribution.fileCount} checksummed file(s) at ${distribution.directory}`,
  );
}

main().catch((error) => {
  console.error(`Bundle failed: ${error.message}`);
  process.exitCode = 1;
});
