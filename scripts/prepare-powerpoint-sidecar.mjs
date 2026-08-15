import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectPe, PE_AMD64_MACHINE } from "./lib/pe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = path.join(ROOT, "src-tauri", "native-assets.json");

function fail(message) {
  throw new Error(message);
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    stdio: options.inherit ? "inherit" : undefined,
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

function rustHostTriple() {
  const output = run("rustc", ["-vV"]);
  const host = /^host:\s*(\S+)\s*$/m.exec(output)?.[1];
  if (!host) {
    fail("rustc -vV did not report a host target triple");
  }
  return host;
}

function sha256Buffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function requireRegularFile(file, label) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${label} is missing: ${path.relative(ROOT, file)}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${label} must be a regular, non-symlink file: ${path.relative(ROOT, file)}`);
  }
  return metadata;
}

export function assertSupportedSidecarHost({ platform, architecture, hostTriple }) {
  const expected =
    platform === "darwin" && architecture === "arm64"
      ? "aarch64-apple-darwin"
      : platform === "win32" && architecture === "x64"
        ? "x86_64-pc-windows-msvc"
        : undefined;
  if (!expected) {
    fail(
      `PowerPoint sidecar preparation supports only macOS arm64 and Windows x64; received ${platform}/${architecture}`,
    );
  }
  if (hostTriple !== expected) {
    fail(
      `PowerPoint sidecar preparation requires rustc host ${expected}; received ${hostTriple}`,
    );
  }
  return expected;
}

export function parsePythonVersion(output) {
  return /^Python\s+(\d+\.\d+\.\d+)\s*$/.exec(output.trim())?.[1];
}

function findPinnedPython(expectedVersion) {
  const configured = process.env.HORIZON_POWERPOINT_PYTHON;
  const candidates = configured
    ? [configured]
    : process.platform === "win32"
      ? ["python"]
      : ["python3", "python"];
  const observed = [];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      continue;
    }
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const version = parsePythonVersion(output);
    observed.push(version ? `${candidate} ${version}` : `${candidate} (unknown version)`);
    if (version === expectedVersion) {
      return candidate;
    }
  }
  fail(
    `PowerPoint sidecar builds require Python ${expectedVersion}; found ${
      observed.join(", ") || "no usable Python interpreter"
    }. Set HORIZON_POWERPOINT_PYTHON to the pinned interpreter.`,
  );
}

export function expectedSidecarPath(targetTriple) {
  const extension = targetTriple.includes("windows") ? ".exe" : "";
  return `src-tauri/binaries/powerpoint-sidecar-${targetTriple}${extension}`;
}

async function verifyArchitecture(file, hostTriple) {
  if (hostTriple === "aarch64-apple-darwin") {
    const architectures = run("lipo", ["-archs", file]).trim().split(/\s+/);
    if (architectures.length !== 1 || architectures[0] !== "arm64") {
      fail(
        `frozen PowerPoint sidecar has architectures ${architectures.join(", ")}; expected only arm64`,
      );
    }
    return;
  }
  const inspection = inspectPe(await readFile(file));
  if (inspection.machine !== PE_AMD64_MACHINE) {
    fail(
      `frozen PowerPoint sidecar uses PE machine 0x${inspection.machine.toString(16)}; expected AMD64 0x8664`,
    );
  }
}

async function verifyFrozenSidecar(file, hostTriple, expectedVersion) {
  const metadata = await requireRegularFile(file, "frozen PowerPoint sidecar");
  if (hostTriple.endsWith("apple-darwin") && (metadata.mode & 0o111) === 0) {
    fail("frozen PowerPoint sidecar has no execute bit");
  }
  await verifyArchitecture(file, hostTriple);
  const reportedVersion = run(file, ["--version"]).trim();
  if (reportedVersion !== expectedVersion) {
    fail(
      `frozen PowerPoint sidecar reported version ${JSON.stringify(reportedVersion)}; expected ${expectedVersion}`,
    );
  }
}

async function verifyFrozenManifestBuild(file, template, workspace) {
  const manifestPath = path.join(workspace, "frozen-smoke-manifest.json");
  const outputPath = path.join(workspace, "frozen-smoke.pptx");
  const reportPath = path.join(workspace, "frozen-smoke.layout-report.json");
  const cancelPath = path.join(workspace, "frozen-smoke.cancel");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        template,
        output: outputPath,
        report: reportPath,
        cancelPath,
        tickets: [
          {
            name: "P000 Frozen Smoke",
            title: "P000 Frozen Smoke",
            blankReason: "Frozen runtime packaging check.",
            master: [],
            deliverables: [],
          },
        ],
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  const output = run(file, ["build-manifest", manifestPath]);
  const events = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`frozen PowerPoint sidecar emitted non-JSON smoke output: ${line}`);
      }
    });
  const completed = events.at(-1);
  if (
    !completed ||
    completed.protocol !== 1 ||
    completed.event !== "completed" ||
    completed.summary?.slidesCreated !== 1 ||
    completed.summary?.blankSlides !== 1
  ) {
    fail("frozen PowerPoint sidecar did not complete the manifest smoke build");
  }

  await requireRegularFile(outputPath, "frozen PowerPoint smoke deck");
  await requireRegularFile(reportPath, "frozen PowerPoint smoke report");
  const deck = await readFile(outputPath);
  if (deck.length < 4 || deck.subarray(0, 4).toString("binary") !== "PK\u0003\u0004") {
    fail("frozen PowerPoint smoke deck is not an OOXML ZIP package");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report.slideCount !== 2 ||
    report.blankTicketCount !== 1 ||
    report.slides?.[0]?.ticket !== "P000 Frozen Smoke"
  ) {
    fail("frozen PowerPoint smoke report has unexpected contents");
  }
}

async function main() {
  const hostTriple = assertSupportedSidecarHost({
    platform: process.platform,
    architecture: process.arch,
    hostTriple: rustHostTriple(),
  });
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const source = manifest.sources?.powerpointSidecar;
  const target = manifest.targets?.[hostTriple]?.powerpointSidecar;
  if (!source || !target) {
    fail(`native-assets.json has no PowerPoint sidecar pins for ${hostTriple}`);
  }
  const expectedPath = expectedSidecarPath(hostTriple);
  if (target.path !== expectedPath) {
    fail(
      `PowerPoint sidecar must use Tauri's exact target-suffixed path ${expectedPath}; manifest contains ${target.path}`,
    );
  }
  if (target.version !== source.version || target.executable !== true) {
    fail(`native-assets.json has inconsistent PowerPoint sidecar metadata for ${hostTriple}`);
  }

  const template = path.resolve(ROOT, source.template.path);
  await requireRegularFile(template, "PowerPoint slide template");
  const templateDigest = sha256Buffer(await readFile(template));
  if (templateDigest !== source.template.sha256) {
    fail(
      `PowerPoint slide template checksum mismatch: expected ${source.template.sha256}, received ${templateDigest}`,
    );
  }

  const specification = path.resolve(ROOT, source.specPath);
  const requirements = path.resolve(ROOT, source.requirementsPath);
  await requireRegularFile(specification, "PyInstaller specification");
  await requireRegularFile(requirements, "PowerPoint sidecar requirements lock");
  const python = findPinnedPython(source.pythonVersion);
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "horizon-traversal-powerpoint-sidecar-"),
  );
  try {
    const virtualEnvironment = path.join(workspace, "venv");
    run(python, ["-m", "venv", virtualEnvironment], { inherit: true });
    const venvPython = path.join(
      virtualEnvironment,
      process.platform === "win32" ? "Scripts" : "bin",
      process.platform === "win32" ? "python.exe" : "python",
    );
    const buildEnvironment = {
      ...process.env,
      PYTHONHASHSEED: "0",
      PYTHONDONTWRITEBYTECODE: "1",
      SOURCE_DATE_EPOCH: String(source.sourceDateEpoch),
    };
    run(
      venvPython,
      [
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--use-feature=truststore",
        "--no-deps",
        "--only-binary=:all:",
        "--require-hashes",
        "--requirement",
        requirements,
      ],
      { env: buildEnvironment, inherit: true },
    );
    const distribution = path.join(workspace, "dist");
    run(
      venvPython,
      [
        "-m",
        "PyInstaller",
        "--clean",
        "--noconfirm",
        "--distpath",
        distribution,
        "--workpath",
        path.join(workspace, "build"),
        specification,
      ],
      { env: buildEnvironment, inherit: true },
    );
    const extension = hostTriple.includes("windows") ? ".exe" : "";
    const built = path.join(distribution, `powerpoint-sidecar${extension}`);
    if (!hostTriple.includes("windows")) {
      await chmod(built, 0o755);
    }
    await verifyFrozenSidecar(built, hostTriple, source.version);
    await verifyFrozenManifestBuild(built, template, workspace);

    const destination = path.resolve(ROOT, target.path);
    await mkdir(path.dirname(destination), { recursive: true });
    const staged = `${destination}.new`;
    await rm(staged, { force: true });
    await copyFile(built, staged);
    if (!hostTriple.includes("windows")) {
      await chmod(staged, 0o755);
    }
    await rm(destination, { force: true });
    await rename(staged, destination);
    await verifyFrozenSidecar(destination, hostTriple, source.version);
    const digest = sha256Buffer(await readFile(destination));
    console.log(
      `Prepared PowerPoint sidecar ${source.version} for ${hostTriple} at ${target.path}`,
    );
    console.log(`PowerPoint sidecar SHA-256 (report only): ${digest}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(`PowerPoint sidecar preparation failed: ${error.message}`);
    process.exitCode = 1;
  });
}
