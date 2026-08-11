import assert from "node:assert/strict";
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
