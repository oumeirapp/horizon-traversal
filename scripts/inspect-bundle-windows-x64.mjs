import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectPe, assertAmd64Pe, PE_AMD64_MACHINE } from "./lib/pe.mjs";

const TARGET = "x86_64-pc-windows-msvc";

function fail(message) {
  throw new Error(message);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function regularFile(file, label) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${label} is missing: ${file}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file: ${file}`);
  }
  return readFile(file);
}

function run(program, args) {
  const result = spawnSync(program, args, {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    fail(`could not run ${program}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(
      `${path.basename(program)} exited with status ${result.status}${
        output ? `: ${output}` : ""
      }`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

export function parseEncoderNames(output) {
  return new Set(
    output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (columns) =>
          /^[VAS]\S{5}$/.test(columns[0] ?? "") && columns[1] !== "=",
      )
      .map((columns) => columns[1]),
  );
}

export function installedPathForDistribution(installDirectory, manifestPath) {
  const prefix = "src-tauri/";
  if (!manifestPath.startsWith(prefix)) {
    fail(`distribution path is outside src-tauri: ${manifestPath}`);
  }
  const relative = manifestPath.slice(prefix.length);
  const parts = relative.split("/");
  if (
    parts.length === 0 ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    fail(`distribution path is unsafe: ${manifestPath}`);
  }
  const resolvedRoot = path.resolve(installDirectory);
  const resolved = path.resolve(resolvedRoot, ...parts);
  const relativeToRoot = path.relative(resolvedRoot, resolved);
  if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
    fail(`distribution path escapes the installed application: ${manifestPath}`);
  }
  return resolved;
}

export function assertWindowsManifest(manifest) {
  if (manifest.schemaVersion !== 2) {
    fail(`unsupported native manifest schema: ${manifest.schemaVersion}`);
  }
  if (!manifest.pinnedTargets?.includes(TARGET)) {
    fail(`native manifest does not pin ${TARGET}`);
  }
  const target = manifest.targets?.[TARGET];
  if (!target || target.platform !== "windows" || target.architecture !== "x86_64") {
    fail(`native manifest has no Windows x64 target definition`);
  }
  return target;
}

function assertDigest(buffer, expected, label) {
  if (!/^[a-f0-9]{64}$/.test(expected ?? "")) {
    fail(`${label} has an invalid expected SHA-256 digest`);
  }
  const actual = sha256(buffer);
  if (actual !== expected) {
    fail(`${label} checksum mismatch: expected ${expected}, received ${actual}`);
  }
  return actual;
}

async function verifyNativeFile(file, entry, policy, label) {
  const contents = await regularFile(file, label);
  const digest = assertDigest(contents, entry.sha256, label);
  const pe = assertAmd64Pe(contents, policy, label);
  return { path: file, sha256: digest, imports: pe.imports };
}

async function isRegularFile(file) {
  try {
    const metadata = await lstat(file);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function verifyApplicationImports(installDirectory, imports, policy) {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot) {
    fail("SystemRoot is unavailable; application imports cannot be resolved");
  }
  const denied = new Set(
    (policy?.deniedNames ?? []).map((name) => name.toLowerCase()),
  );
  const resolved = [];
  for (const dependency of imports) {
    const normalized = dependency.toLowerCase();
    if (denied.has(normalized)) {
      fail(`application executable imports forbidden runtime ${dependency}`);
    }
    if (dependency !== path.win32.basename(dependency)) {
      fail(`application executable contains an unsafe import path: ${dependency}`);
    }
    if (
      normalized.startsWith("api-ms-win-") ||
      normalized.startsWith("ext-ms-win-")
    ) {
      resolved.push({ name: dependency, source: "windows-api-set" });
      continue;
    }

    const bundled = path.join(installDirectory, dependency);
    if (await isRegularFile(bundled)) {
      const contents = await readFile(bundled);
      const pe = inspectPe(contents);
      if (pe.machine !== PE_AMD64_MACHINE) {
        fail(`bundled application dependency ${dependency} is not AMD64`);
      }
      resolved.push({ name: dependency, source: "application-directory" });
      continue;
    }

    const system = path.join(systemRoot, "System32", dependency);
    if (await isRegularFile(system)) {
      resolved.push({ name: dependency, source: "windows-system32" });
      continue;
    }
    fail(`application executable imports unresolved dependency ${dependency}`);
  }
  return resolved;
}

async function verifyDistributionFiles(installDirectory, entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail("native manifest has no distribution files");
  }
  const seen = new Set();
  const verified = [];
  let pdfiumLicenseCount = 0;
  for (const entry of entries) {
    if (seen.has(entry.path)) {
      fail(`native manifest repeats distribution path ${entry.path}`);
    }
    seen.add(entry.path);
    const file = installedPathForDistribution(installDirectory, entry.path);
    const contents = await regularFile(file, `distribution resource ${entry.path}`);
    verified.push({ path: entry.path, sha256: assertDigest(contents, entry.sha256, entry.path) });
    if (entry.path.startsWith("src-tauri/resources/licenses/pdfium/")) {
      pdfiumLicenseCount += 1;
    }
  }
  if (pdfiumLicenseCount < 4) {
    fail(`installed PDFium license set is incomplete: ${pdfiumLicenseCount} files`);
  }
  return verified;
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option?.startsWith("--") || value === undefined || value.startsWith("--")) {
      fail(`invalid inspector argument near ${option ?? "(end of arguments)"}`);
    }
    const name = option.slice(2);
    if (!["install-directory", "app-executable", "source-manifest", "report"].includes(name)) {
      fail(`unknown inspector option ${option}`);
    }
    if (result[name] !== undefined) {
      fail(`inspector option ${option} was provided more than once`);
    }
    result[name] = path.resolve(value);
  }
  for (const required of ["install-directory", "app-executable", "source-manifest"]) {
    if (!result[required]) {
      fail(`missing required inspector option --${required}`);
    }
  }
  return result;
}

export async function inspectInstalledBundle(options) {
  const installDirectory = path.resolve(options["install-directory"]);
  const appExecutable = path.resolve(options["app-executable"]);
  const appRelative = path.relative(installDirectory, appExecutable);
  if (appRelative.startsWith("..") || path.isAbsolute(appRelative)) {
    fail("application executable is outside the install directory");
  }

  const sourceManifest = await regularFile(options["source-manifest"], "source native manifest");
  const bundledManifestPath = path.join(installDirectory, "native-assets.json");
  const bundledManifest = await regularFile(bundledManifestPath, "bundled native manifest");
  if (!sourceManifest.equals(bundledManifest)) {
    fail("bundled native-assets.json differs from the verified source manifest");
  }
  const manifest = JSON.parse(bundledManifest.toString("utf8"));
  const target = assertWindowsManifest(manifest);
  const policy = target.dynamicDependencies;

  const appContents = await regularFile(appExecutable, "application executable");
  const appPe = inspectPe(appContents);
  if (appPe.machine !== PE_AMD64_MACHINE) {
    fail(
      `application executable uses PE machine 0x${appPe.machine.toString(16)}; expected AMD64 0x8664`,
    );
  }
  const applicationImports = await verifyApplicationImports(
    installDirectory,
    appPe.imports,
    target.dynamicDependencies,
  );

  const ffmpegPath = path.join(installDirectory, "ffmpeg.exe");
  const ffprobePath = path.join(installDirectory, "ffprobe.exe");
  const pdfiumPath = path.join(installDirectory, "native", "pdfium.dll");
  const ffmpeg = await verifyNativeFile(ffmpegPath, target.ffmpeg, policy, "ffmpeg");
  const ffprobe = await verifyNativeFile(ffprobePath, target.ffprobe, policy, "ffprobe");
  const pdfium = await verifyNativeFile(pdfiumPath, target.pdfium, policy, "PDFium");

  const ffmpegVersion = run(ffmpegPath, ["-hide_banner", "-version"]);
  const ffprobeVersion = run(ffprobePath, ["-hide_banner", "-version"]);
  if (!ffmpegVersion.startsWith(`ffmpeg version ${target.ffmpeg.version}`)) {
    fail(`installed ffmpeg did not report version ${target.ffmpeg.version}`);
  }
  if (!ffprobeVersion.startsWith(`ffprobe version ${target.ffprobe.version}`)) {
    fail(`installed ffprobe did not report version ${target.ffprobe.version}`);
  }
  for (const option of target.ffmpeg.requiredConfiguration) {
    if (!ffmpegVersion.includes(option) || !ffprobeVersion.includes(option)) {
      fail(`installed media tools are missing required build option ${option}`);
    }
  }
  const encoders = parseEncoderNames(run(ffmpegPath, ["-hide_banner", "-encoders"]));
  for (const encoder of target.ffmpeg.requiredEncoders) {
    if (!encoders.has(encoder)) {
      fail(`installed ffmpeg does not provide required encoder ${encoder}`);
    }
  }

  const distributions = await verifyDistributionFiles(
    installDirectory,
    manifest.distributionFiles,
  );
  const report = {
    schemaVersion: 1,
    target: TARGET,
    installDirectory,
    application: {
      path: appExecutable,
      sha256: sha256(appContents),
      imports: applicationImports,
    },
    nativeAssets: { ffmpeg, ffprobe, pdfium },
    requiredEncoders: target.ffmpeg.requiredEncoders,
    distributionFiles: distributions,
  };

  if (options.report) {
    await writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
  }
  return report;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    if (process.platform !== "win32" || process.arch !== "x64") {
      fail(`Windows bundle inspection requires native Windows x64; received ${process.platform}/${process.arch}`);
    }
    const report = await inspectInstalledBundle(parseArguments(process.argv.slice(2)));
    console.log(
      `Windows bundle inspection passed: ${report.installDirectory} (${report.distributionFiles.length} distribution files)`,
    );
  } catch (error) {
    console.error(`Windows bundle inspection failed: ${error.message}`);
    process.exitCode = 1;
  }
}
