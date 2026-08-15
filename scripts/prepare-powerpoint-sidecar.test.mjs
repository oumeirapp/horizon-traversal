import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertSupportedSidecarHost,
  expectedSidecarPath,
  parsePythonVersion,
} from "./prepare-powerpoint-sidecar.mjs";

test("uses Tauri's exact target-suffixed sidecar paths", () => {
  assert.equal(
    expectedSidecarPath("aarch64-apple-darwin"),
    "src-tauri/binaries/powerpoint-sidecar-aarch64-apple-darwin",
  );
  assert.equal(
    expectedSidecarPath("x86_64-pc-windows-msvc"),
    "src-tauri/binaries/powerpoint-sidecar-x86_64-pc-windows-msvc.exe",
  );
});

test("accepts only the two pinned native build hosts", () => {
  assert.equal(
    assertSupportedSidecarHost({
      platform: "darwin",
      architecture: "arm64",
      hostTriple: "aarch64-apple-darwin",
    }),
    "aarch64-apple-darwin",
  );
  assert.equal(
    assertSupportedSidecarHost({
      platform: "win32",
      architecture: "x64",
      hostTriple: "x86_64-pc-windows-msvc",
    }),
    "x86_64-pc-windows-msvc",
  );
  assert.throws(
    () =>
      assertSupportedSidecarHost({
        platform: "linux",
        architecture: "x64",
        hostTriple: "x86_64-unknown-linux-gnu",
      }),
    /supports only macOS arm64 and Windows x64/,
  );
});

test("requires a complete pinned Python version", () => {
  assert.equal(parsePythonVersion("Python 3.11.9\n"), "3.11.9");
  assert.equal(parsePythonVersion("Python 3.11\n"), undefined);
});

test("preparation installs only exact requirements and validates the frozen program", async () => {
  const source = await readFile(
    new URL("./prepare-powerpoint-sidecar.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /"--no-deps"/);
  assert.match(source, /"--only-binary=:all:"/);
  assert.match(source, /"--require-hashes"/);
  assert.match(source, /"--use-feature=truststore"/);
  assert.match(source, /"--version"/);
  assert.match(source, /"build-manifest"/);
  assert.match(source, /P000 Frozen Smoke/);
  assert.match(source, /frozen PowerPoint smoke deck/);
  assert.match(source, /verifyArchitecture/);
  assert.match(source, /source\.template\.sha256/);
});
