import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const inspectorUrl = new URL("./inspect-bundle-macos-arm64.sh", import.meta.url);
const inspectorPath = fileURLToPath(inspectorUrl);

test("macOS inspector reports actual media hashes without manifest pins", async () => {
  const source = await readFile(inspectorUrl, "utf8");
  assert.doesNotMatch(source, /(?:ffmpeg|ffprobe)\.sha256/);
  assert.doesNotMatch(
    source,
    /HORIZON_TRAVERSAL_(?:FFMPEG|FFPROBE)_SHA256/,
  );
  assert.match(source, /print_hash "\$FFMPEG" "ffmpeg"/);
  assert.match(source, /print_hash "\$FFPROBE" "ffprobe"/);
  assert.match(source, /ffmpeg\.requiredConfiguration\.\$configuration_index/);
  assert.match(source, /ffmpeg\.requiredEncoders\.\$encoder_index/);
  assert.match(source, /ffprobe is missing required configuration/);
  assert.match(source, /ffmpeg does not provide required encoder/);
  assert.match(
    source,
    /targets\.aarch64-apple-darwin\.pdfium\.sha256/,
  );
});

test("macOS inspector remains valid POSIX shell", () => {
  const result = spawnSync("sh", ["-n", inspectorPath], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});
