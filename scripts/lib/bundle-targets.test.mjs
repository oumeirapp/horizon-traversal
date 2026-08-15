import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertBundleEnvironment,
  bundleEnvironment,
  PINNED_NODE_VERSION,
  resolveBundleTarget,
} from "./bundle-targets.mjs";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function mergeConfiguration(base, override) {
  if (
    !base ||
    !override ||
    Array.isArray(base) ||
    Array.isArray(override) ||
    typeof base !== "object" ||
    typeof override !== "object"
  ) {
    return structuredClone(override);
  }
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged
      ? mergeConfiguration(merged[key], value)
      : structuredClone(value);
  }
  return merged;
}

test("macOS bundle target is Apple Silicon app and DMG", () => {
  const target = assertBundleEnvironment("macos", {
    platform: "darwin",
    architecture: "arm64",
    rustHost: "aarch64-apple-darwin",
    nodeVersion: PINNED_NODE_VERSION,
  });

  assert.deepEqual([...target.tauriArguments], [
    "build",
    "--target",
    "aarch64-apple-darwin",
    "--bundles",
    "app,dmg",
    "--ci",
  ]);
  assert.equal(target.tauriArguments.includes("--no-sign"), false);
});

test("Windows bundle target is unsigned x64 NSIS", () => {
  const target = assertBundleEnvironment("windows", {
    platform: "win32",
    architecture: "x64",
    rustHost: "x86_64-pc-windows-msvc",
    nodeVersion: PINNED_NODE_VERSION,
  });

  assert.deepEqual([...target.tauriArguments], [
    "build",
    "--target",
    "x86_64-pc-windows-msvc",
    "--bundles",
    "nsis",
    "--ci",
    "--no-sign",
  ]);
});

test("bundle guards reject the wrong architecture, Rust host, and Node", () => {
  assert.throws(
    () =>
      assertBundleEnvironment("macos", {
        platform: "darwin",
        architecture: "x64",
        rustHost: "x86_64-apple-darwin",
        nodeVersion: PINNED_NODE_VERSION,
      }),
    /requires darwin-arm64/,
  );
  assert.throws(
    () =>
      assertBundleEnvironment("windows", {
        platform: "win32",
        architecture: "x64",
        rustHost: "x86_64-pc-windows-gnu",
        nodeVersion: PINNED_NODE_VERSION,
      }),
    /requires rustc host x86_64-pc-windows-msvc/,
  );
  assert.throws(
    () =>
      assertBundleEnvironment("macos", {
        platform: "darwin",
        architecture: "arm64",
        rustHost: "aarch64-apple-darwin",
        nodeVersion: "25.0.0",
      }),
    /requires Node 24\.14\.0/,
  );
  assert.throws(() => resolveBundleTarget("linux"), /expected macos or windows/);
});

test("macOS bundle environment forces ad-hoc signing and disables notarization", () => {
  const inherited = {
    PATH: "/usr/bin",
    APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
    APPLE_CERTIFICATE: "certificate",
    APPLE_CERTIFICATE_PASSWORD: "password",
    APPLE_ID: "developer@example.com",
    APPLE_PASSWORD: "app-password",
    APPLE_TEAM_ID: "TEAMID",
    APPLE_API_KEY: "key",
    APPLE_API_ISSUER: "issuer",
    APPLE_API_KEY_PATH: "/private/key.p8",
  };

  const cargoTargetDirectory = path.resolve("test-cargo-target");
  const environment = bundleEnvironment("macos", inherited, cargoTargetDirectory);
  assert.equal(environment.PATH, inherited.PATH);
  assert.equal(environment.CARGO_TARGET_DIR, cargoTargetDirectory);
  assert.equal(environment.APPLE_SIGNING_IDENTITY, "-");
  for (const variable of Object.keys(inherited).filter((name) =>
    name.startsWith("APPLE_") && name !== "APPLE_SIGNING_IDENTITY"
  )) {
    assert.equal(environment[variable], undefined);
  }
  assert.equal(inherited.APPLE_ID, "developer@example.com");
});

test("bundle environment replaces inherited Cargo target paths", () => {
  const cargoTargetDirectory = path.resolve("clean-cargo-target");
  const environment = bundleEnvironment(
    "windows",
    { Cargo_Target_Dir: "C:\\stale", PATH: "C:\\Windows" },
    cargoTargetDirectory,
  );
  assert.equal(environment.Cargo_Target_Dir, undefined);
  assert.equal(environment.CARGO_TARGET_DIR, cargoTargetDirectory);
  assert.throws(
    () => bundleEnvironment("windows", {}, "relative-target"),
    /must be absolute/,
  );
});

test("Tauri platform merge retains shared resources and adds Windows PDFium", async () => {
  const base = JSON.parse(
    await readFile(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  const windows = JSON.parse(
    await readFile(
      path.join(ROOT, "src-tauri", "tauri.windows.conf.json"),
      "utf8",
    ),
  );
  const merged = mergeConfiguration(base, windows);

  assert.deepEqual(base.bundle.externalBin, [
    "binaries/ffmpeg",
    "binaries/ffprobe",
    "binaries/powerpoint-sidecar",
  ]);
  assert.deepEqual(base.bundle.resources, {
    "../powerpoint-sidecar/resources/Slide template.pptx":
      "powerpoint/Slide template.pptx",
    "../powerpoint-sidecar/THIRD_PARTY_NOTICES.md":
      "powerpoint/THIRD_PARTY_NOTICES.md",
    "../powerpoint-sidecar/requirements-bundle.txt":
      "powerpoint/requirements-bundle.txt",
    "../powerpoint-sidecar/licenses": "powerpoint/licenses",
    "native-assets.json": "native-assets.json",
    "binaries/THIRD_PARTY_NOTICES.md":
      "binaries/THIRD_PARTY_NOTICES.md",
    "binaries/licenses": "binaries/licenses",
    "resources/licenses/pdfium": "resources/licenses/pdfium",
  });
  assert.equal(base.bundle.macOS.signingIdentity, "-");
  assert.equal(base.bundle.macOS.hardenedRuntime, false);
  assert.deepEqual(merged.bundle.targets, ["nsis"]);
  assert.equal(
    merged.bundle.resources["resources/native/pdfium.dll"],
    "native/pdfium.dll",
  );
  assert.equal(
    merged.bundle.resources["resources/licenses/pdfium"],
    "resources/licenses/pdfium",
  );
  assert.deepEqual(merged.bundle.windows.webviewInstallMode, {
    type: "downloadBootstrapper",
    silent: true,
  });
  assert.equal(merged.bundle.windows.nsis.installMode, "currentUser");
});

test("CI packages downloadable non-release apps on pushes and manual runs", async () => {
  const workflow = await readFile(
    path.join(ROOT, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const packageCondition =
    "    if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'";

  assert.equal(workflow.split(packageCondition).length - 1, 2);
  assert.match(
    workflow,
    /name: horizon-traversal-macos-arm64-adhoc-unnotarized-non-release/,
  );
  assert.match(
    workflow,
    /name: horizon-traversal-windows-x64-unsigned-non-release/,
  );
});
