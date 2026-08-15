import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  assertWindowsManifest,
  inspectNativeContents,
  installedPathForDistribution,
  parseEncoderNames,
} from "./inspect-bundle-windows-x64.mjs";

function amd64PeFixture() {
  const buffer = Buffer.alloc(0x200);
  buffer.writeUInt16LE(0x5a4d, 0);
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x00004550, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(0, 0x86);
  buffer.writeUInt16LE(0xf0, 0x94);
  const optional = 0x98;
  buffer.writeUInt16LE(0x20b, optional);
  buffer.writeUInt32LE(0, optional + 108);
  return buffer;
}

test("maps declared distribution resources beneath the install root", () => {
  const installed = installedPathForDistribution(
    path.resolve("installed"),
    "src-tauri/binaries/licenses/GPL-2.0-or-later.txt",
  );
  assert.equal(
    installed,
    path.resolve("installed", "binaries", "licenses", "GPL-2.0-or-later.txt"),
  );
});

test("rejects distribution resource traversal", () => {
  assert.throws(
    () => installedPathForDistribution(path.resolve("installed"), "src-tauri/../secret"),
    /unsafe/,
  );
  assert.throws(
    () => installedPathForDistribution(path.resolve("installed"), "outside/file"),
    /outside src-tauri/,
  );
});

test("parses FFmpeg encoder table entries", () => {
  const encoders = parseEncoderNames(`
 Encoders:
 V..... = Video
 V....D libx264             libx264 H.264
 A....D aac                 AAC
  `);
  assert.deepEqual([...encoders], ["libx264", "aac"]);
});

test("requires the schema-v2 Windows x64 target", () => {
  const target = {
    platform: "windows",
    architecture: "x86_64",
    powerpointSidecar: { version: "0.1.0" },
  };
  assert.equal(
    assertWindowsManifest({
      schemaVersion: 2,
      pinnedTargets: ["x86_64-pc-windows-msvc"],
      sources: { powerpointSidecar: { version: "0.1.0" } },
      targets: { "x86_64-pc-windows-msvc": target },
    }),
    target,
  );
  assert.throws(
    () => assertWindowsManifest({ schemaVersion: 1 }),
    /unsupported native manifest schema/,
  );
});

test("reports a media digest without requiring an expected output hash", () => {
  const contents = amd64PeFixture();
  const inspection = inspectNativeContents(contents, {
    dependencyPolicy: { allowedNames: [] },
    label: "ffmpeg",
  });
  assert.equal(
    inspection.sha256,
    createHash("sha256").update(contents).digest("hex"),
  );
  assert.deepEqual(inspection.imports, []);
});

test("still enforces a supplied PDFium output hash", () => {
  assert.throws(
    () =>
      inspectNativeContents(amd64PeFixture(), {
        dependencyPolicy: { allowedNames: [] },
        enforceSha256: true,
        expectedSha256: "0".repeat(64),
        label: "PDFium",
      }),
    /PDFium checksum mismatch/,
  );
  assert.throws(
    () =>
      inspectNativeContents(amd64PeFixture(), {
        dependencyPolicy: { allowedNames: [] },
        enforceSha256: true,
        label: "PDFium",
      }),
    /invalid expected SHA-256 digest/,
  );
});

test("never reads media output hashes from the Windows manifest", async () => {
  const source = await readFile(
    new URL("./inspect-bundle-windows-x64.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /target\.(?:ffmpeg|ffprobe)\.sha256/);
  assert.match(source, /target\.pdfium\.sha256/);
  assert.match(source, /powerpoint-sidecar\.exe/);
  assert.match(source, /powerpointSidecarPath, \["--version"\]/);
  assert.match(source, /Slide template\.pptx/);
  assert.match(source, /THIRD_PARTY_NOTICES\.md/);
  assert.match(source, /requirements-bundle\.txt/);
  assert.match(source, /powerpoint["',\s\r\n]+["']licenses/);
  assert.match(source, /PowerPoint license tree/);
  assert.match(source, /verifyHashedTree/);
  assert.match(
    source,
    /manifest\.sources\?\.powerpointSidecar\?\.template\?\.sha256/,
  );
});
