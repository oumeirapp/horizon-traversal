import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertTargetOutputPins } from "./verify-native-assets.mjs";

const SHA256 = "a".repeat(64);

test("target output pins require only the PDFium digest", () => {
  assert.doesNotThrow(() =>
    assertTargetOutputPins("test-target", {
      ffmpeg: { sha256: "legacy-invalid-digest" },
      ffprobe: {},
      pdfium: { sha256: SHA256 },
    }),
  );
  assert.throws(
    () => assertTargetOutputPins("test-target", { pdfium: {} }),
    /test-target PDFium output hash/,
  );
});

test("native verification never reads media output hashes", async () => {
  const source = await readFile(
    new URL("./verify-native-assets.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /(?:target|declaredTarget)\.(?:ffmpeg|ffprobe)\.sha256/,
  );
  assert.match(source, /manifest\.sources\.ffmpeg\.sha256/);
  assert.match(source, /target\.pdfium\?\.sha256/);
});

test("native configuration pins the frozen sidecar and verified template", async () => {
  const manifest = JSON.parse(
    await readFile(
      new URL("../src-tauri/native-assets.json", import.meta.url),
      "utf8",
    ),
  );
  const configuration = JSON.parse(
    await readFile(
      new URL("../src-tauri/tauri.conf.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(configuration.bundle.externalBin, [
    "binaries/ffmpeg",
    "binaries/ffprobe",
    "binaries/powerpoint-sidecar",
  ]);
  assert.equal(
    configuration.bundle.resources[
      "../powerpoint-sidecar/resources/Slide template.pptx"
    ],
    "powerpoint/Slide template.pptx",
  );
  assert.equal(
    configuration.bundle.resources[
      "../powerpoint-sidecar/THIRD_PARTY_NOTICES.md"
    ],
    "powerpoint/THIRD_PARTY_NOTICES.md",
  );
  assert.equal(
    configuration.bundle.resources[
      "../powerpoint-sidecar/requirements-bundle.txt"
    ],
    "powerpoint/requirements-bundle.txt",
  );
  assert.equal(
    configuration.bundle.resources["../powerpoint-sidecar/licenses"],
    "powerpoint/licenses",
  );
  const source = manifest.sources.powerpointSidecar;
  const template = await readFile(
    new URL("../powerpoint-sidecar/resources/Slide template.pptx", import.meta.url),
  );
  assert.equal(
    createHash("sha256").update(template).digest("hex"),
    source.template.sha256,
  );
  for (const resource of [source.notices, source.dependencyInventory]) {
    const contents = await readFile(new URL(`../${resource.path}`, import.meta.url));
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      resource.sha256,
    );
  }
  assert.equal(source.licenses.path, "powerpoint-sidecar/licenses");
  assert.equal(source.licenses.bundlePath, "powerpoint/licenses");
  assert.equal(source.licenses.fileCount, 39);
  assert.match(source.licenses.sha256, /^[a-f0-9]{64}$/);
  assert.equal(source.pythonVersion, "3.11.9");
  assert.equal(source.pyinstallerVersion, "6.16.0");
  for (const target of manifest.pinnedTargets) {
    assert.equal(
      manifest.targets[target].powerpointSidecar.path,
      `src-tauri/binaries/powerpoint-sidecar-${target}${
        target.includes("windows") ? ".exe" : ""
      }`,
    );
  }
});

test("native verifier checks the sidecar architecture and CLI version", async () => {
  const source = await readFile(
    new URL("./verify-native-assets.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /verifyPowerPointSidecarVersion/);
  assert.match(source, /verifyProgramPath\(\s*"powerpoint-sidecar"/);
  assert.match(
    source,
    /target\.powerpointSidecar\.dynamicDependencies/,
  );
  assert.match(source, /verifyMacArchitecture\(file, target\.architecture\)/);
  assert.match(source, /PowerPoint slide template checksum mismatch|template\?\.sha256/);
  assert.match(source, /verifyHashedTree/);
  assert.match(source, /PowerPoint sidecar license tree/);
});
