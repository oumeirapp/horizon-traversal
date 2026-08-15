import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { assertAmd64Pe } from "./lib/pe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "src-tauri", "native-assets.json");

function fail(message) {
  throw new Error(message);
}

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    fail(`could not run ${program}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(
      `${program} ${args.join(" ")} exited with status ${result.status}${
        output ? `: ${output}` : ""
      }`,
    );
  }

  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function detectHostTriple() {
  const rustcVersion = run("rustc", ["-vV"]);
  const host = /^host:\s*(\S+)\s*$/m.exec(rustcVersion)?.[1];
  if (!host) {
    fail("rustc -vV did not report a host target triple");
  }
  return host;
}

function assertSha256(value, description) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail(`${description} is not a lowercase SHA-256 digest`);
  }
}

export function assertTargetOutputPins(targetTriple, target) {
  assertSha256(target.pdfium?.sha256, `${targetTriple} PDFium output hash`);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function verifyFile(
  entry,
  { executable, hostTriple, verifySha256 = false },
) {
  const absolutePath = path.resolve(ROOT, entry.path);
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    fail(`native asset escapes the repository: ${entry.path}`);
  }

  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`required native asset is missing: ${entry.path}`);
    }
    throw error;
  }

  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`native asset must be a regular, non-symlink file: ${entry.path}`);
  }

  const actualDigest = await sha256(absolutePath);
  if (verifySha256) {
    assertSha256(entry.sha256, `${entry.path} manifest hash`);
  }
  if (verifySha256 && actualDigest !== entry.sha256) {
    fail(
      `${entry.path} checksum mismatch: expected ${entry.sha256}, received ${actualDigest}`,
    );
  }

  const isWindowsTarget = hostTriple.includes("windows");
  if (!isWindowsTarget && executable && (metadata.mode & 0o111) === 0) {
    fail(`native executable has no execute bit: ${entry.path}`);
  }
  if (!isWindowsTarget && !executable && (metadata.mode & 0o111) !== 0) {
    fail(`native library unexpectedly has an execute bit: ${entry.path}`);
  }

  return { path: absolutePath, sha256: actualDigest };
}

function verifyProgramPath(program, entry, hostTriple) {
  const extension = hostTriple.includes("windows") ? ".exe" : "";
  const expected = `src-tauri/binaries/${program}-${hostTriple}${extension}`;
  if (entry.path !== expected) {
    fail(
      `${program} must use Tauri's exact target-suffixed path ${expected}; manifest contains ${entry.path}`,
    );
  }
}

function verifyVersion(program, binary, entry) {
  const output = run(binary, ["-hide_banner", "-version"]);
  if (!output.startsWith(`${program} version ${entry.version}`)) {
    fail(`${program} did not report pinned version ${entry.version}`);
  }
  return output;
}

function verifyPowerPointSidecarVersion(binary, entry) {
  const output = run(binary, ["--version"]).trim();
  if (output !== entry.version) {
    fail(
      `powerpoint-sidecar reported version ${JSON.stringify(output)}; expected ${entry.version}`,
    );
  }
}

function verifyEncoders(binary, requiredEncoders) {
  const output = run(binary, ["-hide_banner", "-encoders"]);
  const encoderNames = new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter((columns) => /^[VAS]\S{5}$/.test(columns[0] ?? ""))
      .map((columns) => columns[1]),
  );

  for (const encoder of requiredEncoders) {
    if (!encoderNames.has(encoder)) {
      fail(`FFmpeg does not provide the required ${encoder} encoder`);
    }
  }
}

function verifyMacArchitecture(file, expectedArchitecture) {
  const architectures = run("lipo", ["-archs", file]).trim().split(/\s+/);
  if (
    architectures.length !== 1 ||
    architectures[0] !== expectedArchitecture
  ) {
    fail(
      `${path.basename(file)} has architectures ${architectures.join(", ")}; expected only ${expectedArchitecture}`,
    );
  }
}

function verifyMacDependencies(file, dependencyPolicy, allowInstallNames = false) {
  const dependencies = run("otool", ["-L", file])
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim().split(/\s+\(/, 1)[0])
    .filter(Boolean);

  for (const dependency of dependencies) {
    const isAllowed =
      (allowInstallNames &&
        dependencyPolicy.allowedInstallNames.includes(dependency)) ||
      dependencyPolicy.allowedPrefixes.some((prefix) =>
        dependency.startsWith(prefix),
      );
    if (!isAllowed) {
      fail(
        `${path.basename(file)} has a non-system dynamic dependency: ${dependency}`,
      );
    }
  }
}

async function listFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listFiles(child)));
    } else if (entry.isFile()) {
      result.push(child);
    } else {
      fail(`distribution resource must not be a symlink: ${path.relative(ROOT, child)}`);
    }
  }
  return result;
}

async function verifyHashedTree(entry, label) {
  const absolutePath = path.resolve(ROOT, entry.path);
  const relativeRoot = path.relative(ROOT, absolutePath);
  if (relativeRoot.startsWith("..") || path.isAbsolute(relativeRoot)) {
    fail(`${label} escapes the repository: ${entry.path}`);
  }

  let metadata;
  try {
    metadata = await lstat(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${label} is missing: ${entry.path}`);
    }
    throw error;
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink directory: ${entry.path}`);
  }

  const files = (await listFiles(absolutePath)).sort();
  if (!Number.isSafeInteger(entry.fileCount) || entry.fileCount <= 0) {
    fail(`${label} must declare a positive file count`);
  }
  if (files.length !== entry.fileCount) {
    fail(
      `${label} contains ${files.length} files; expected ${entry.fileCount}`,
    );
  }

  const treeHash = createHash("sha256");
  for (const file of files) {
    const relativePath = path
      .relative(absolutePath, file)
      .split(path.sep)
      .join("/");
    treeHash.update(`${await sha256(file)}  ${relativePath}\n`);
  }
  const actualDigest = treeHash.digest("hex");
  assertSha256(entry.sha256, `${label} manifest hash`);
  if (actualDigest !== entry.sha256) {
    fail(
      `${label} checksum mismatch: expected ${entry.sha256}, received ${actualDigest}`,
    );
  }
  return { path: absolutePath, sha256: actualDigest, fileCount: files.length };
}

async function verifyDistributionFiles(entries, hostTriple) {
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      fail(`duplicate distribution file in native manifest: ${entry.path}`);
    }
    seen.add(entry.path);
    await verifyFile(entry, {
      executable: false,
      hostTriple,
      verifySha256: true,
    });
  }

  const wheelDirectory = path.join(
    ROOT,
    "src-tauri",
    "resources",
    "licenses",
    "pdfium",
    "wheel",
  );
  const actualWheelLicenses = (await listFiles(wheelDirectory))
    .map((file) => path.relative(ROOT, file).split(path.sep).join("/"))
    .sort();
  const declaredWheelLicenses = entries
    .map((entry) => entry.path)
    .filter((file) =>
      file.startsWith("src-tauri/resources/licenses/pdfium/wheel/"),
    )
    .sort();

  if (declaredWheelLicenses.length < 4) {
    fail("native-assets.json must declare the complete pinned PDFium wheel license set");
  }

  if (
    actualWheelLicenses.length !== declaredWheelLicenses.length ||
    actualWheelLicenses.some(
      (file, index) => file !== declaredWheelLicenses[index],
    )
  ) {
    fail("the PDFium wheel license directory does not match native-assets.json");
  }
}

async function verifyTauriConfiguration(
  hostTriple,
  manifestTarget,
  powerpointSource,
) {
  const configurationPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
  const externalBin = [...(configuration.bundle?.externalBin ?? [])].sort();
  const expectedExternalBin = [
    "binaries/ffmpeg",
    "binaries/ffprobe",
    "binaries/powerpoint-sidecar",
  ];
  if (JSON.stringify(externalBin) !== JSON.stringify(expectedExternalBin)) {
    fail(
      "tauri.conf.json must bundle only the suffix-free FFmpeg, FFprobe, and PowerPoint sidecar paths",
    );
  }

  const resources = configuration.bundle?.resources ?? [];
  const configuredResources = Array.isArray(resources)
    ? resources
    : Object.values(resources);
  const requiredResources = [
    "native-assets.json",
    "binaries/THIRD_PARTY_NOTICES.md",
    "binaries/licenses",
  ];
  for (const resource of requiredResources) {
    if (!configuredResources.includes(resource)) {
      fail(`tauri.conf.json does not bundle required resource ${resource}`);
    }
  }
  if (!configuredResources.some((resource) => resource.startsWith("resources/licenses/pdfium"))) {
    fail("tauri.conf.json does not bundle the PDFium license tree");
  }
  if (Array.isArray(resources)) {
    fail("tauri.conf.json must map PowerPoint resources to fixed bundle paths");
  }
  for (const resource of [
    powerpointSource.template,
    powerpointSource.notices,
    powerpointSource.dependencyInventory,
    powerpointSource.licenses,
  ]) {
    const configurationSource = `../${resource.path}`;
    if (resources[configurationSource] !== resource.bundlePath) {
      fail(
        `tauri.conf.json must bundle verified PowerPoint resource ${resource.path} at ${resource.bundlePath}`,
      );
    }
  }

  if (hostTriple.endsWith("apple-darwin")) {
    const frameworks = configuration.bundle?.macOS?.frameworks ?? [];
    if (
      frameworks.length !== 1 ||
      frameworks[0] !== "resources/native/libpdfium.dylib"
    ) {
      fail("tauri.conf.json must bundle the pinned PDFium dylib as its only macOS framework");
    }
    if (
      configuration.bundle?.macOS?.minimumSystemVersion !==
      manifestTarget.mediaBuild.minimumSystemVersion
    ) {
      fail(
        `tauri.conf.json macOS minimum version must match native build ${manifestTarget.mediaBuild.minimumSystemVersion}`,
      );
    }
  }
}

async function verifyPreparationScripts(manifest, hostTriple, target) {
  const buildScriptPath = path.resolve(ROOT, target.mediaBuild.script);
  if (!buildScriptPath.startsWith(`${ROOT}${path.sep}`)) {
    fail(`native build script escapes the repository: ${target.mediaBuild.script}`);
  }
  const buildScript = await readFile(buildScriptPath, "utf8");
  const requiredBuildValues = [
    manifest.sources.ffmpeg.version,
    manifest.sources.ffmpeg.sha256,
    manifest.sources.x264.revision,
    manifest.sources.x264.sha256,
    hostTriple,
    String(target.mediaBuild.sourceDateEpoch),
    "https://ffmpeg.org/releases/",
    "https://code.videolan.org/videolan/x264/",
  ];
  if (target.platform === "darwin") {
    requiredBuildValues.push(
      target.mediaBuild.minimumSystemVersion,
      target.mediaBuild.compiler,
      target.mediaBuild.toolchainPackageVersion,
      target.mediaBuild.sdkVersion,
    );
  }
  for (const value of requiredBuildValues) {
    if (typeof value !== "string" || !buildScript.includes(value)) {
      fail(
        `${target.mediaBuild.script} does not contain pinned manifest value ${value}`,
      );
    }
  }

  const pdfiumScriptPath = path.join(ROOT, "scripts", "prepare-pdfium.mjs");
  const pdfiumScript = await readFile(pdfiumScriptPath, "utf8");
  const requiredPdfiumValues = ["native-assets.json", "pdfiumWheels"];
  for (const value of requiredPdfiumValues) {
    if (!pdfiumScript.includes(value)) {
      fail(`scripts/prepare-pdfium.mjs does not contain pinned manifest value ${value}`);
    }
  }

  const powerpointSource = manifest.sources.powerpointSidecar;
  const powerpointScriptPath = path.join(
    ROOT,
    "scripts",
    "prepare-powerpoint-sidecar.mjs",
  );
  const powerpointScript = await readFile(powerpointScriptPath, "utf8");
  for (const value of [
    "native-assets.json",
    "source.specPath",
    "source.requirementsPath",
    "--only-binary=:all:",
    "--require-hashes",
    "--version",
  ]) {
    if (!powerpointScript.includes(value)) {
      fail(
        `scripts/prepare-powerpoint-sidecar.mjs is missing required build contract ${value}`,
      );
    }
  }
  const requirements = await readFile(
    path.resolve(ROOT, powerpointSource.requirementsPath),
    "utf8",
  );
  if (!requirements.includes(`pyinstaller==${powerpointSource.pyinstallerVersion}`)) {
    fail(
      `PowerPoint sidecar requirements do not pin PyInstaller ${powerpointSource.pyinstallerVersion}`,
    );
  }
  const packageSource = await readFile(
    path.join(ROOT, "powerpoint-sidecar", "src", "horizon_pptx", "__init__.py"),
    "utf8",
  );
  if (!packageSource.includes(`__version__ = "${powerpointSource.version}"`)) {
    fail(
      `PowerPoint sidecar source does not declare version ${powerpointSource.version}`,
    );
  }
}

async function verifyWebviewBoundary() {
  const capabilityDirectory = path.join(ROOT, "src-tauri", "capabilities");
  const forbiddenPermissionPrefixes = ["shell:", "opener:", "fs:"];
  for (const entry of await readdir(capabilityDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }
    const capabilityPath = path.join(capabilityDirectory, entry.name);
    const capability = JSON.parse(await readFile(capabilityPath, "utf8"));
    for (const permission of capability.permissions ?? []) {
      const identifier =
        typeof permission === "string" ? permission : permission?.identifier;
      if (
        typeof identifier === "string" &&
        forbiddenPermissionPrefixes.some((prefix) =>
          identifier === prefix.slice(0, -1) || identifier.startsWith(prefix),
        )
      ) {
        fail(
          `the webview capability ${entry.name} must not expose native ${identifier.split(":", 1)[0]} APIs: ${identifier}`,
        );
      }
    }
  }

  const packageManifest = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8"),
  );
  const frontendPackages = new Set(
    [
      packageManifest.dependencies,
      packageManifest.devDependencies,
      packageManifest.optionalDependencies,
      packageManifest.peerDependencies,
    ].flatMap((section) => Object.keys(section ?? {})),
  );
  const forbiddenFrontendPackages = [
    "@tauri-apps/plugin-fs",
    "@tauri-apps/plugin-opener",
    "@tauri-apps/plugin-shell",
  ];
  for (const dependency of forbiddenFrontendPackages) {
    if (frontendPackages.has(dependency)) {
      fail(
        `the React webview must not depend on native package ${dependency}; use a narrow Rust command`,
      );
    }
  }
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (manifest.schemaVersion !== 2) {
    fail(`unsupported native asset manifest schema: ${manifest.schemaVersion}`);
  }

  const pinnedTargets = new Set(manifest.pinnedTargets ?? []);
  if (pinnedTargets.size === 0) {
    fail("native-assets.json must declare at least one pinned target");
  }
  for (const targetTriple of pinnedTargets) {
    const declaredTarget = manifest.targets?.[targetTriple];
    const declaredWheel = manifest.sources?.pdfiumWheels?.[targetTriple];
    if (!declaredTarget || !declaredWheel) {
      fail(`native-assets.json has incomplete pins for ${targetTriple}`);
    }
    if (declaredTarget.ffmpeg.version !== manifest.sources.ffmpeg.version) {
      fail(`${targetTriple} FFmpeg binary version does not match the source pin`);
    }
    if (declaredTarget.ffprobe.version !== manifest.sources.ffmpeg.version) {
      fail(`${targetTriple} FFprobe binary version does not match the source pin`);
    }
    if (declaredTarget.pdfium.version !== declaredWheel.pdfiumVersion) {
      fail(`${targetTriple} PDFium binary version does not match its wheel pin`);
    }
    if (
      declaredTarget.powerpointSidecar?.version !==
      manifest.sources.powerpointSidecar?.version
    ) {
      fail(`${targetTriple} PowerPoint sidecar version does not match its source pin`);
    }
    assertTargetOutputPins(targetTriple, declaredTarget);
    if (
      typeof declaredTarget.mediaBuild?.compiler !== "string" ||
      declaredTarget.mediaBuild.compiler.length === 0
    ) {
      fail(`${targetTriple} must pin the native media compiler identity`);
    }
    verifyProgramPath("ffmpeg", declaredTarget.ffmpeg, targetTriple);
    verifyProgramPath("ffprobe", declaredTarget.ffprobe, targetTriple);
    verifyProgramPath(
      "powerpoint-sidecar",
      declaredTarget.powerpointSidecar,
      targetTriple,
    );
  }
  for (const targetTriple of Object.keys(manifest.targets ?? {})) {
    if (!pinnedTargets.has(targetTriple)) {
      fail(`native-assets.json target ${targetTriple} is not listed in pinnedTargets`);
    }
  }

  const hostTriple = detectHostTriple();
  if (!manifest.pinnedTargets.includes(hostTriple)) {
    fail(
      `native-assets.json has no pinned assets for rustc host ${hostTriple}; available targets: ${manifest.pinnedTargets.join(", ")}`,
    );
  }
  const target = manifest.targets[hostTriple];
  if (!target) {
    fail(`native-assets.json is missing target details for ${hostTriple}`);
  }

  if (target.ffmpeg.version !== manifest.sources.ffmpeg.version) {
    fail("FFmpeg binary version and source version do not match in native-assets.json");
  }
  if (target.ffprobe.version !== manifest.sources.ffmpeg.version) {
    fail("FFprobe binary version and FFmpeg source version do not match in native-assets.json");
  }
  const pdfiumWheel = manifest.sources.pdfiumWheels?.[hostTriple];
  if (!pdfiumWheel) {
    fail(`native-assets.json has no PDFium wheel for ${hostTriple}`);
  }
  if (target.pdfium.version !== pdfiumWheel.pdfiumVersion) {
    fail("PDFium binary version and wheel version do not match in native-assets.json");
  }
  const powerpointSource = manifest.sources.powerpointSidecar;
  if (
    !powerpointSource ||
    target.powerpointSidecar?.version !== powerpointSource.version
  ) {
    fail(
      "PowerPoint sidecar binary version and source version do not match in native-assets.json",
    );
  }
  assertSha256(
    powerpointSource.template?.sha256,
    "PowerPoint slide template hash",
  );
  assertSha256(
    powerpointSource.notices?.sha256,
    "PowerPoint sidecar notices hash",
  );
  assertSha256(
    powerpointSource.dependencyInventory?.sha256,
    "PowerPoint sidecar dependency inventory hash",
  );
  assertSha256(
    powerpointSource.licenses?.sha256,
    "PowerPoint sidecar license tree hash",
  );
  assertSha256(manifest.sources.ffmpeg.sha256, "FFmpeg source hash");
  assertSha256(manifest.sources.x264.sha256, "x264 source hash");
  for (const [targetTriple, wheel] of Object.entries(manifest.sources.pdfiumWheels)) {
    assertSha256(wheel.sha256, `${targetTriple} PDFium wheel source hash`);
  }
  for (const [targetTriple, tools] of Object.entries(manifest.toolchains ?? {})) {
    for (const [toolName, tool] of Object.entries(tools)) {
      assertSha256(tool.sha256, `${targetTriple} ${toolName} source hash`);
    }
  }

  const expectedPlatform = hostTriple.endsWith("apple-darwin")
    ? "darwin"
    : hostTriple.includes("windows")
      ? "windows"
      : "linux";
  if (target.platform !== expectedPlatform) {
    fail(
      `target ${hostTriple} must declare platform ${expectedPlatform}; manifest contains ${target.platform}`,
    );
  }
  if (
    target.ffmpeg.executable !== true ||
    target.ffprobe.executable !== true ||
    target.powerpointSidecar.executable !== true ||
    target.pdfium.executable !== false
  ) {
    fail("native-assets.json has invalid executable flags for bundled native tools");
  }

  verifyProgramPath("ffmpeg", target.ffmpeg, hostTriple);
  verifyProgramPath("ffprobe", target.ffprobe, hostTriple);
  verifyProgramPath(
    "powerpoint-sidecar",
    target.powerpointSidecar,
    hostTriple,
  );
  const expectedPdfiumName =
    target.platform === "darwin"
      ? "libpdfium.dylib"
      : target.platform === "windows"
        ? "pdfium.dll"
        : "libpdfium.so";
  const expectedPdfiumPath = `src-tauri/resources/native/${expectedPdfiumName}`;
  if (target.pdfium.path !== expectedPdfiumPath) {
    fail(
      `PDFium must use exact native-library path ${expectedPdfiumPath}; manifest contains ${target.pdfium.path}`,
    );
  }
  const ffmpegInspection = await verifyFile(target.ffmpeg, {
    executable: true,
    hostTriple,
  });
  const ffprobeInspection = await verifyFile(target.ffprobe, {
    executable: true,
    hostTriple,
  });
  const pdfiumInspection = await verifyFile(target.pdfium, {
    executable: false,
    hostTriple,
    verifySha256: true,
  });
  const powerpointInspection = await verifyFile(target.powerpointSidecar, {
    executable: true,
    hostTriple,
  });
  await verifyFile(powerpointSource.template, {
    executable: false,
    hostTriple,
    verifySha256: true,
  });
  await verifyFile(powerpointSource.notices, {
    executable: false,
    hostTriple,
    verifySha256: true,
  });
  await verifyFile(powerpointSource.dependencyInventory, {
    executable: false,
    hostTriple,
    verifySha256: true,
  });
  await verifyHashedTree(
    powerpointSource.licenses,
    "PowerPoint sidecar license tree",
  );
  const ffmpeg = ffmpegInspection.path;
  const ffprobe = ffprobeInspection.path;
  const pdfium = pdfiumInspection.path;
  const powerpointSidecar = powerpointInspection.path;

  console.log(`ffmpeg SHA-256 (report only): ${ffmpegInspection.sha256}`);
  console.log(`ffprobe SHA-256 (report only): ${ffprobeInspection.sha256}`);
  console.log(
    `PowerPoint sidecar SHA-256 (report only): ${powerpointInspection.sha256}`,
  );

  if (target.platform === "windows") {
    const dependencyPolicy = target.dynamicDependencies;
    for (const [label, file] of [
      ["ffmpeg", ffmpeg],
      ["ffprobe", ffprobe],
      ["PDFium", pdfium],
    ]) {
      const inspection = assertAmd64Pe(
        await readFile(file),
        dependencyPolicy,
        label,
      );
      console.log(`${label} PE imports: ${inspection.imports.join(", ") || "(none)"}`);
    }
    const powerpointInspection = assertAmd64Pe(
      await readFile(powerpointSidecar),
      target.powerpointSidecar.dynamicDependencies,
      "powerpoint-sidecar",
    );
    console.log(
      `powerpoint-sidecar PE imports: ${powerpointInspection.imports.join(", ") || "(none)"}`,
    );
  }

  const ffmpegVersion = verifyVersion("ffmpeg", ffmpeg, target.ffmpeg);
  const ffprobeVersion = verifyVersion("ffprobe", ffprobe, target.ffprobe);
  const compilerLine = `built with ${target.mediaBuild.compiler}`;
  if (
    !ffmpegVersion.includes(compilerLine) ||
    !ffprobeVersion.includes(compilerLine)
  ) {
    fail(`bundled media tools were not built with ${target.mediaBuild.compiler}`);
  }
  for (const option of target.ffmpeg.requiredConfiguration) {
    if (!ffmpegVersion.includes(option) || !ffprobeVersion.includes(option)) {
      fail(`bundled media tools were not built with required option ${option}`);
    }
  }
  verifyEncoders(ffmpeg, target.ffmpeg.requiredEncoders);
  verifyPowerPointSidecarVersion(
    powerpointSidecar,
    target.powerpointSidecar,
  );

  if (target.platform === "darwin") {
    for (const file of [ffmpeg, ffprobe, pdfium, powerpointSidecar]) {
      verifyMacArchitecture(file, target.architecture);
    }
    verifyMacDependencies(ffmpeg, target.dynamicDependencies);
    verifyMacDependencies(ffprobe, target.dynamicDependencies);
    verifyMacDependencies(pdfium, target.dynamicDependencies, true);
    verifyMacDependencies(powerpointSidecar, target.dynamicDependencies);
  }

  await verifyDistributionFiles(manifest.distributionFiles, hostTriple);
  await verifyTauriConfiguration(hostTriple, target, powerpointSource);
  await verifyPreparationScripts(manifest, hostTriple, target);
  await verifyWebviewBoundary();

  console.log(
    `Verified ${hostTriple}: FFmpeg/FFprobe ${target.ffmpeg.version}, PDFium ${target.pdfium.version}, PowerPoint sidecar ${target.powerpointSidecar.version}, and ${manifest.distributionFiles.length} distribution files.`,
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`Native asset verification failed: ${error.message}`);
    process.exitCode = 1;
  });
}
