import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  assertWindowsManifest,
  installedPathForDistribution,
  parseEncoderNames,
} from "./inspect-bundle-windows-x64.mjs";

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
  const target = { platform: "windows", architecture: "x86_64" };
  assert.equal(
    assertWindowsManifest({
      schemaVersion: 2,
      pinnedTargets: ["x86_64-pc-windows-msvc"],
      targets: { "x86_64-pc-windows-msvc": target },
    }),
    target,
  );
  assert.throws(
    () => assertWindowsManifest({ schemaVersion: 1 }),
    /unsupported native manifest schema/,
  );
});
