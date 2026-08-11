import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const macosBuilder = await readFile(
  new URL("./build-native-macos-arm64.sh", import.meta.url),
  "utf8",
);
const windowsBuilder = await readFile(
  new URL("./build-native-windows-x64.ps1", import.meta.url),
  "utf8",
);
const nativeManifest = JSON.parse(
  await readFile(new URL("../src-tauri/native-assets.json", import.meta.url), "utf8"),
);
const windowsConfiguration =
  nativeManifest.targets["x86_64-pc-windows-msvc"].ffmpeg.requiredConfiguration;

test("macOS builder validates one semantic build and only reports output hashes", () => {
  assert.doesNotMatch(macosBuilder, /(?:FFMPEG|FFPROBE)_BINARY_SHA256/);
  assert.doesNotMatch(macosBuilder, /checksum does not match the release manifest/);
  assert.match(macosBuilder, /download_verified[\s\S]*FFMPEG_SHA256/);
  assert.match(macosBuilder, /lipo -archs/);
  assert.match(macosBuilder, /verify_system_dependencies/);
  assert.match(macosBuilder, /did not report pinned version/);
  assert.match(macosBuilder, /does not contain the libx264 encoder/);
  assert.match(macosBuilder, /does not contain the AAC encoder/);
  assert.match(macosBuilder, /Prepared %s \(%s\).*sha256/s);
});

test("Windows builder performs exactly one clean build with strict validation", () => {
  assert.equal(
    windowsBuilder.match(/^Invoke-CleanMediaBuild\s+/gm)?.length,
    1,
  );
  assert.doesNotMatch(windowsBuilder, /clean-build-[12]|ComparisonDirectory/);
  assert.doesNotMatch(
    windowsBuilder,
    /NATIVE_HASH_BOOTSTRAP|ExpectedFfmpegSha256|ExpectedFfprobeSha256/,
  );
  assert.doesNotMatch(
    windowsBuilder,
    /ManifestTarget\.(?:ffmpeg|ffprobe)\.sha256/,
  );
  assert.match(windowsBuilder, /Assert-Equal \$ManifestFfmpeg\.sha256/);
  assert.match(windowsBuilder, /Assert-Equal \$ManifestX264\.sha256/);
  assert.match(windowsBuilder, /Assert-Equal \$ManifestToolchain\.sha256/);
  assert.equal(
    windowsBuilder.match(/^Assert-Binary .* \$false$/gm)?.length,
    2,
  );
  assert.match(windowsBuilder, /IMAGE_FILE_MACHINE_AMD64/);
  assert.match(windowsBuilder, /imports undeclared runtime/);
  assert.match(windowsBuilder, /\$ExitCode = \$LASTEXITCODE/);
  assert.match(
    windowsBuilder,
    /failed with exit code \$ExitCode \(0x\$ExitCodeHex\) while running/,
  );
  assert.match(
    windowsBuilder,
    /function Assert-Binary[\s\S]*Assert-SystemImports[\s\S]*\$VersionOutput = Invoke-NativeCapture/,
  );
  assert.match(windowsBuilder, /did not report pinned version/);
  assert.match(windowsBuilder, /required configuration/);
  assert.match(windowsBuilder, /does not contain the libx264 encoder/);
  assert.match(windowsBuilder, /does not contain the AAC encoder/);
  assert.match(windowsBuilder, /--disable-stripping/);
  assert.ok(windowsConfiguration.includes("--disable-stripping"));
  assert.doesNotMatch(windowsBuilder, /\$STRIP" --strip-all/);
  assert.doesNotMatch(windowsBuilder, /\bGet-FileHash\b/);
  assert.match(windowsBuilder, /\[System\.Security\.Cryptography\.SHA256\]::Create\(\)/);
  assert.match(windowsBuilder, /\.ComputeHash\(\$Stream\)/);
  assert.match(windowsBuilder, /Prepared \$Destination \(\$\(Get-Sha256/);
});
