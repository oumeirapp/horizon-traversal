import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { assertNode24, resolveSmokeRunner } from "./run-package-smoke.mjs";

const windowsSmoke = await readFile(
  new URL("./build-and-run-windows-x64.ps1", import.meta.url),
  "utf8",
);
const macosSmoke = await readFile(
  new URL("./build-and-run-macos-arm64.sh", import.meta.url),
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

test("package smokes verify exact per-ticket and aggregate CSV content", () => {
  for (const smoke of [macosSmoke, windowsSmoke]) {
    assert.match(smoke, /Deliverables[\\/]Creative/);
    assert.match(smoke, /Master Files[\\/]Print/);
    assert.match(smoke, /Brief\.pdf/);
    assert.match(smoke, /MasterBrief\.pdf/);
    assert.match(smoke, /Visual_2400x1500px\.png/);
    assert.match(smoke, /Clip_0\.2s_1080x1920px\.mp4/);
    assert.match(smoke, /report\.csv/);
    assert.match(smoke, /Name,Ticket,Folder,Size/);
    assert.match(smoke, /Brief\.pdf,P1,Creative,Unknown/);
    assert.match(smoke, /Clip\.mp4,P1,Creative,0\.2 sec 1080x1920["']/);
    assert.match(smoke, /Visual\.png,P1,Creative,2400x1500["']/);
    assert.match(smoke, /MasterBrief\.pdf,P1,Print,Unknown["']/);
    assert.doesNotMatch(smoke, /["']Ticket,Folder,Size["']/);
    assert.doesNotMatch(smoke, /report\.txt/);
    assert.doesNotMatch(smoke, /ticket report is missing source path/);
  }
  assert.match(macosSmoke, /cmp -s "\$EXPECTED_REPORT" "\$REPORT"/);
  assert.match(
    macosSmoke,
    /MASTER_OUTPUT="\$TICKET_OUTPUT\/Master"/,
  );
  assert.match(
    macosSmoke,
    /DELIVERABLES_OUTPUT="\$TICKET_OUTPUT\/Deliverables"/,
  );
  assert.match(macosSmoke, /require_file "\$MASTER_OUTPUT\/MasterBrief\.png"/);
  assert.match(macosSmoke, /require_file "\$DELIVERABLES_OUTPUT\/Brief\.png"/);
  assert.match(
    macosSmoke,
    /AGGREGATE_REPORT="\$OUTPUT_DIRECTORY\/1\. report\.csv"/,
  );
  assert.match(
    macosSmoke,
    /cmp -s "\$EXPECTED_REPORT" "\$AGGREGATE_REPORT"/,
  );
  assert.match(windowsSmoke, /\$ActualReport\.Equals\(\$ExpectedReport/);
  assert.match(
    windowsSmoke,
    /\$MasterOutput = Join-Path \$TicketOutput "Master"/,
  );
  assert.match(
    windowsSmoke,
    /\$DeliverablesOutput = Join-Path \$TicketOutput "Deliverables"/,
  );
  assert.match(
    windowsSmoke,
    /\$MasterPdfImage = Join-Path \$MasterOutput "MasterBrief\.png"/,
  );
  assert.match(
    windowsSmoke,
    /\$PdfImage = Join-Path \$DeliverablesOutput "Brief\.png"/,
  );
  assert.match(
    windowsSmoke,
    /\$AggregateReport = Join-Path \$OutputDirectory "1\. report\.csv"/,
  );
  assert.match(
    windowsSmoke,
    /\$ActualAggregateReport\.Equals\(\$ExpectedReport/,
  );
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
