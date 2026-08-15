import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  assembleDistribution,
  verifyDistribution,
} from "./distribution-package.mjs";

const temporaryRoots = new Set();

afterEach(async () => {
  await Promise.all(
    [...temporaryRoots].map((root) => rm(root, { recursive: true, force: true })),
  );
  temporaryRoots.clear();
});

async function writeFixtureFile(root, relativePath, contents) {
  const destination = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}

async function createFixture(targetName, artifactNames) {
  const root = await mkdtemp(path.join(os.tmpdir(), "horizon-distribution-test-"));
  temporaryRoots.add(root);
  const defaults =
    targetName === "macos"
      ? ["Horizon Traversal_0.1.0_aarch64.dmg"]
      : ["Horizon Traversal_0.1.0_x64-setup.exe"];
  const artifactDirectory =
    targetName === "macos"
      ? "src-tauri/target/aarch64-apple-darwin/release/bundle/dmg"
      : "src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis";
  await mkdir(path.join(root, ...artifactDirectory.split("/")), {
    recursive: true,
  });
  for (const [index, artifactName] of (artifactNames ?? defaults).entries()) {
    await writeFixtureFile(
      root,
      `${artifactDirectory}/${artifactName}`,
      `installer-${index}`,
    );
  }
  await writeFixtureFile(
    root,
    "src-tauri/target/release-artifacts/Horizon-Traversal-native-source.zip",
    "deterministic source archive",
  );
  await writeFixtureFile(
    root,
    "src-tauri/binaries/THIRD_PARTY_NOTICES.md",
    "third-party notices\n",
  );
  await writeFixtureFile(
    root,
    "src-tauri/binaries/licenses/GPL-2.0-or-later.txt",
    "GPL license\n",
  );
  await writeFixtureFile(
    root,
    "src-tauri/binaries/licenses/windows/llvm-mingw/LICENSE.TXT",
    "LLVM license\n",
  );
  await writeFixtureFile(
    root,
    "src-tauri/binaries/licenses/windows/mingw-w64/COPYING",
    "MinGW license\n",
  );
  await writeFixtureFile(
    root,
    "powerpoint-sidecar/THIRD_PARTY_NOTICES.md",
    "PowerPoint notices\n",
  );
  await writeFixtureFile(
    root,
    "powerpoint-sidecar/requirements-bundle.txt",
    "Pillow==11.3.0\n",
  );
  await writeFixtureFile(
    root,
    "powerpoint-sidecar/licenses/Pillow-11.3.0/LICENSE",
    "Pillow license\n",
  );
  return root;
}

async function collectFiles(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path.join(directory, entry.name), relativePath)));
    } else {
      files.push(relativePath);
    }
  }
  return files.sort();
}

function cargoTargetDirectory(root) {
  return path.join(root, "src-tauri", "target");
}

test("assembles and verifies a deterministic macOS companion distribution", async () => {
  const root = await createFixture("macos");
  await writeFixtureFile(
    root,
    "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Horizon Traversal.app/Contents/MacOS/Horizon Traversal",
    "application",
  );
  await writeFixtureFile(
    root,
    "src-tauri/target/release-artifacts/macos-aarch64/stale.txt",
    "stale",
  );

  const result = await assembleDistribution({
    root,
    targetName: "macos",
    cargoTargetDirectory: cargoTargetDirectory(root),
  });
  assert.equal(
    result.directory,
    path.join(
      root,
      "src-tauri",
      "target",
      "release-artifacts",
      "macos-aarch64",
    ),
  );
  assert.equal(
    path.basename(result.artifact),
    "Horizon Traversal_0.1.0_aarch64.dmg",
  );
  assert.deepEqual(await collectFiles(result.directory), [
    "Horizon Traversal_0.1.0_aarch64.dmg",
    "Horizon-Traversal-native-source.zip",
    "SHA256SUMS",
    "THIRD_PARTY_NOTICES.md",
    "licenses/GPL-2.0-or-later.txt",
    "licenses/windows/llvm-mingw/LICENSE.TXT",
    "licenses/windows/mingw-w64/COPYING",
    "powerpoint/THIRD_PARTY_NOTICES.md",
    "powerpoint/licenses/Pillow-11.3.0/LICENSE",
    "powerpoint/requirements-bundle.txt",
  ]);
  await lstat(
    path.join(
      root,
      "src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Horizon Traversal.app",
    ),
  );

  const firstChecksums = await readFile(
    path.join(result.directory, "SHA256SUMS"),
    "utf8",
  );
  const checksumPaths = firstChecksums
    .trimEnd()
    .split("\n")
    .map((line) => line.slice(66));
  assert.deepEqual(checksumPaths, [...checksumPaths].sort());

  await assembleDistribution({
    root,
    targetName: "macos",
    cargoTargetDirectory: cargoTargetDirectory(root),
  });
  assert.equal(
    await readFile(path.join(result.directory, "SHA256SUMS"), "utf8"),
    firstChecksums,
  );
});

test("assembles the Windows NSIS installer into its target-specific directory", async () => {
  const root = await createFixture("windows");
  const result = await assembleDistribution({
    root,
    targetName: "windows",
    cargoTargetDirectory: cargoTargetDirectory(root),
  });

  assert.equal(
    result.directory,
    path.join(
      root,
      "src-tauri",
      "target",
      "release-artifacts",
      "windows-x64",
    ),
  );
  assert.equal(
    await readFile(result.artifact, "utf8"),
    "installer-0",
  );
  assert.equal(result.fileCount, 9);
  await verifyDistribution({
    root,
    targetName: "windows",
    cargoTargetDirectory: cargoTargetDirectory(root),
  });
});

test("fails closed on missing or multiple installers without replacing prior output", async () => {
  const missingRoot = await createFixture("macos", []);
  await assert.rejects(
    assembleDistribution({
      root: missingRoot,
      targetName: "macos",
      cargoTargetDirectory: cargoTargetDirectory(missingRoot),
    }),
    /expected exactly one \.dmg installer.*found 0/,
  );

  const multipleRoot = await createFixture("windows", ["one.exe", "two.exe"]);
  const prior = await writeFixtureFile(
    multipleRoot,
    "src-tauri/target/release-artifacts/windows-x64/prior.txt",
    "prior distribution",
  );
  await assert.rejects(
    assembleDistribution({
      root: multipleRoot,
      targetName: "windows",
      cargoTargetDirectory: cargoTargetDirectory(multipleRoot),
    }),
    /expected exactly one \.exe installer.*found 2/,
  );
  assert.equal(await readFile(prior, "utf8"), "prior distribution");
});

test("verification rejects altered files and paths outside release artifacts", async () => {
  const root = await createFixture("macos");
  const result = await assembleDistribution({
    root,
    targetName: "macos",
    cargoTargetDirectory: cargoTargetDirectory(root),
  });
  await writeFile(result.artifact, "tampered installer");
  await assert.rejects(
    verifyDistribution({
      root,
      targetName: "macos",
      cargoTargetDirectory: cargoTargetDirectory(root),
    }),
    /assembled distribution file was altered/,
  );
  await assert.rejects(
    verifyDistribution({
      root,
      targetName: "macos",
      cargoTargetDirectory: cargoTargetDirectory(root),
      directory: path.join(root, "outside-dist"),
    }),
    /distribution directory is outside release artifacts/,
  );
  await assert.rejects(
    assembleDistribution({
      root,
      targetName: "linux",
      cargoTargetDirectory: cargoTargetDirectory(root),
    }),
    /expected macos or windows/,
  );
});

test(
  "rejects a symbolic-link installer",
  { skip: process.platform === "win32" },
  async () => {
    const root = await createFixture("macos", []);
    const target = await writeFixtureFile(root, "real-installer", "installer");
    const artifactDirectory = path.join(
      root,
      "src-tauri/target/aarch64-apple-darwin/release/bundle/dmg",
    );
    await mkdir(artifactDirectory, { recursive: true });
    await symlink(target, path.join(artifactDirectory, "linked.dmg"));

    await assert.rejects(
      assembleDistribution({
        root,
        targetName: "macos",
        cargoTargetDirectory: cargoTargetDirectory(root),
      }),
      /installer artifact is not a regular file/,
    );
  },
);
