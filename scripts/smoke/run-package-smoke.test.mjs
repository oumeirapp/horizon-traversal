import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertNode24, resolveSmokeRunner } from "./run-package-smoke.mjs";

const windowsSmoke = await readFile(
  new URL("./build-and-run-windows-x64.ps1", import.meta.url),
  "utf8",
);

test("preserves the existing Apple Silicon macOS smoke runner", () => {
  const runner = resolveSmokeRunner({ platform: "darwin", architecture: "arm64" });
  assert.equal(runner.program, "sh");
  assert.equal(path.basename(runner.args[0]), "build-and-run-macos-arm64.sh");
});

test("uses Windows PowerShell 5.1 for the Windows x64 smoke runner", () => {
  const runner = resolveSmokeRunner({
    platform: "win32",
    architecture: "x64",
    environment: { SystemRoot: "C:\\Windows" },
  });
  assert.equal(
    runner.program,
    path.win32.join(
      "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  );
  assert.deepEqual(runner.args.slice(0, 6), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
  ]);
  assert.equal(path.win32.basename(runner.args[6]), "build-and-run-windows-x64.ps1");
});

test("Windows smoke creates and inspects PNG fixtures without FFmpeg PNG support", () => {
  assert.match(
    windowsSmoke,
    /New-Object System\.Drawing\.Bitmap -ArgumentList 2400, 1500/,
  );
  assert.match(
    windowsSmoke,
    /\[System\.Drawing\.Imaging\.ImageFormat\]::Png/,
  );
  assert.match(
    windowsSmoke,
    /Write-OversizedPng -Source \$ImageFixture -Destination/,
  );
  assert.match(
    windowsSmoke,
    /function Assert-ImageBounds[\s\S]*\$Image\.Width[\s\S]*\$Image\.Height/,
  );
  assert.match(windowsSmoke, /\$SourceImage\.Dispose\(\)/);
  assert.match(windowsSmoke, /\$Graphics\.Dispose\(\)/);
  assert.match(windowsSmoke, /\$Bitmap\.Dispose\(\)/);
  assert.match(windowsSmoke, /\$Image\.Dispose\(\)/);
  assert.doesNotMatch(windowsSmoke, /scale=2400:1500/);
  assert.doesNotMatch(windowsSmoke, /Assert-ImageBounds -Ffprobe/);
});

test("rejects unsupported package-smoke platforms", () => {
  assert.throws(
    () => resolveSmokeRunner({ platform: "linux", architecture: "x64" }),
    /supports only macOS arm64 and Windows x64/,
  );
  assert.throws(
    () => resolveSmokeRunner({ platform: "win32", architecture: "arm64" }),
    /supports only macOS arm64 and Windows x64/,
  );
});

test("rejects runtimes other than Node 24", () => {
  assert.doesNotThrow(() => assertNode24("24.14.0"));
  assert.throws(() => assertNode24("24.13.1"), /requires Node 24\.14\.0/);
});
