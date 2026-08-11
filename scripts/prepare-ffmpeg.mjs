import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import extract from "extract-zip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MACOS_TARGET = "aarch64-apple-darwin";
const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
const MANIFEST_PATH = path.join(ROOT, "src-tauri", "native-assets.json");

const WINDOWS_TOOLCHAINS = {
  llvmMingw: {
    version: "20260616",
    url: "https://github.com/mstorsjo/llvm-mingw/releases/download/20260616/llvm-mingw-20260616-ucrt-x86_64.zip",
    sha256:
      "b9b68a4d276e16fa25802aaba458e4638f64b3884c290aaccdc2d87083b6ca35",
    archive: "llvm-mingw-20260616-ucrt-x86_64.zip",
  },
  msys2Base: {
    version: "20260611",
    url: "https://repo.msys2.org/distrib/x86_64/msys2-base-x86_64-20260611.tar.xz",
    sha256:
      "a2d047e8ee213c3c6a49a8de427eb1069df12207c0422ff1b3cbb5c905c34221",
    archive: "msys2-base-x86_64-20260611.tar.xz",
  },
  make: {
    version: "4.4.1-3",
    url: "https://repo.msys2.org/msys/x86_64/make-4.4.1-3-x86_64.pkg.tar.zst",
    sha256:
      "af0bdba17f06fe037f0194069adaa31a8fe45f1a11381501896aea1fae37bd5d",
    archive: "make-4.4.1-3-x86_64.pkg.tar.zst",
  },
  nasm: {
    version: "3.02",
    url: "https://www.nasm.us/pub/nasm/releasebuilds/3.02/win64/nasm-3.02-win64.zip",
    sha256:
      "161d0bfaff53c2f9e9f3e69fd0672323ebabafd1268976a5cec11be92a19aee7",
    archive: "nasm-3.02-win64.zip",
  },
};

function fail(message) {
  throw new Error(message);
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function requireFile(file, description) {
  let metadata;
  try {
    metadata = await stat(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail(`${description} is missing: ${file}`);
    }
    throw error;
  }
  if (!metadata.isFile()) {
    fail(`${description} is not a regular file: ${file}`);
  }
}

async function downloadVerified(source, destination) {
  const partial = `${destination}.part`;
  await rm(partial, { force: true });

  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`Downloading ${source.url}`);
      const response = await fetch(source.url, { redirect: "follow" });
      if (!response.ok || !response.body) {
        fail(`download failed with HTTP ${response.status}: ${source.url}`);
      }
      if (new URL(response.url).protocol !== "https:") {
        fail(`download redirected away from HTTPS: ${response.url}`);
      }

      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(partial, { flags: "wx" }),
      );
      const actual = await sha256(partial);
      if (actual !== source.sha256) {
        fail(
          `${source.archive} checksum mismatch: expected ${source.sha256}, received ${actual}`,
        );
      }
      await rename(partial, destination);
      return;
    } catch (error) {
      lastError = error;
      await rm(partial, { force: true });
      if (attempt < 3) {
        console.warn(`Download attempt ${attempt} failed; retrying.`);
      }
    }
  }

  throw lastError;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? ROOT,
      env: options.env ?? process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          signal
            ? `${path.basename(command)} was terminated by ${signal}`
            : `${path.basename(command)} exited with status ${code}`,
        ),
      );
    });
  });
}

function runCaptured(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    fail(
      `${path.basename(command)} exited with status ${result.status}${
        output ? `: ${output}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

async function assertWindowsManifestPins() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  const declared = manifest.toolchains?.[WINDOWS_TARGET];
  if (!declared) {
    fail(`native-assets.json has no toolchain pins for ${WINDOWS_TARGET}`);
  }

  for (const [name, expected] of Object.entries(WINDOWS_TOOLCHAINS)) {
    const actual = declared[name];
    if (!actual) {
      fail(`native-assets.json is missing the ${name} toolchain pin`);
    }
    for (const field of ["version", "url", "sha256"]) {
      if (String(actual[field]) !== expected[field]) {
        fail(
          `native-assets.json ${name}.${field} does not match the Windows builder pin`,
        );
      }
    }
  }

  const target = manifest.targets?.[WINDOWS_TARGET];
  if (!target) {
    fail(`native-assets.json has no output pins for ${WINDOWS_TARGET}`);
  }
  return target;
}

async function preparedBinariesMatch(target, targetTriple) {
  for (const [program, asset] of [
    ["FFmpeg", target.ffmpeg],
    ["FFprobe", target.ffprobe],
  ]) {
    if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256 ?? "")) {
      fail(`native-assets.json has no valid ${program} output hash for ${targetTriple}`);
    }
    const binary = path.join(ROOT, ...asset.path.split("/"));
    try {
      if (!(await stat(binary)).isFile() || (await sha256(binary)) !== asset.sha256) {
        return false;
      }
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
  return true;
}

async function prepareWindows() {
  if (process.arch !== "x64") {
    fail(`Windows media preparation requires x64; received ${process.arch}`);
  }
  const target = await assertWindowsManifestPins();
  if (await preparedBinariesMatch(target, WINDOWS_TARGET)) {
    console.log(`FFmpeg and FFprobe are already prepared for ${WINDOWS_TARGET}.`);
    return;
  }

  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot) {
    fail("Windows did not provide SystemRoot or WINDIR");
  }
  const systemTar = path.join(systemRoot, "System32", "tar.exe");
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  await requireFile(systemTar, "Windows archive tool");
  await requireFile(powershell, "Windows PowerShell");

  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "horizon-traversal-native-"),
  );
  const keepBuild = process.env.HORIZON_TRAVERSAL_KEEP_NATIVE_BUILD === "1";

  try {
    const downloads = path.join(temporaryDirectory, "downloads");
    const toolchains = path.join(temporaryDirectory, "toolchains");
    const buildDirectory = path.join(temporaryDirectory, "build");
    await mkdir(downloads);
    await mkdir(toolchains);
    await mkdir(buildDirectory);

    const archives = Object.fromEntries(
      Object.entries(WINDOWS_TOOLCHAINS).map(([name, source]) => [
        name,
        path.join(downloads, source.archive),
      ]),
    );
    const downloadResults = await Promise.allSettled(
      Object.entries(WINDOWS_TOOLCHAINS).map(([name, source]) =>
        downloadVerified(source, archives[name]),
      ),
    );
    const failedDownload = downloadResults.find(
      (result) => result.status === "rejected",
    );
    if (failedDownload) {
      throw failedDownload.reason;
    }

    await extract(archives.llvmMingw, { dir: toolchains });
    await extract(archives.nasm, { dir: toolchains });
    await run(systemTar, [
      "-xJf",
      archives.msys2Base,
      "-C",
      toolchains,
    ]);

    const llvmRoot = path.join(
      toolchains,
      "llvm-mingw-20260616-ucrt-x86_64",
    );
    const msysRoot = path.join(toolchains, "msys64");
    const nasmRoot = path.join(toolchains, "nasm-3.02");
    const bash = path.join(msysRoot, "usr", "bin", "bash.exe");
    const cygpath = path.join(msysRoot, "usr", "bin", "cygpath.exe");
    const msysEnvironment = {
      ...process.env,
      CHERE_INVOKING: "1",
      MSYSTEM: "MSYS",
      PATH: `${path.join(msysRoot, "usr", "bin")}${path.delimiter}${
        process.env.PATH ?? ""
      }`,
    };

    for (const [file, description] of [
      [path.join(llvmRoot, "bin", "x86_64-w64-mingw32-clang.exe"), "LLVM-MinGW compiler"],
      [path.join(llvmRoot, "bin", "llvm-ar.exe"), "LLVM archive tool"],
      [bash, "MSYS2 bash"],
      [cygpath, "MSYS2 path converter"],
      [path.join(msysRoot, "usr", "bin", "tar.exe"), "MSYS2 archive tool"],
      [path.join(msysRoot, "usr", "bin", "zstd.exe"), "MSYS2 zstd tool"],
      [path.join(nasmRoot, "nasm.exe"), "NASM assembler"],
    ]) {
      await requireFile(file, description);
    }

    const makeArchiveMsys = runCaptured(cygpath, ["-u", archives.make], {
      env: msysEnvironment,
    });
    await run(
      bash,
      [
        "--noprofile",
        "--norc",
        "-c",
        'exec /usr/bin/tar --zstd --extract --file "$1" --directory /',
        "horizon-extract-make",
        makeArchiveMsys,
      ],
      { env: msysEnvironment },
    );
    await requireFile(
      path.join(msysRoot, "usr", "bin", "make.exe"),
      "pinned MSYS2 Make",
    );

    const builder = path.join(
      ROOT,
      "scripts",
      "build-native-windows-x64.ps1",
    );
    await requireFile(builder, "Windows media builder");
    await run(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        builder,
      ],
      {
        env: {
          ...process.env,
          HORIZON_TRAVERSAL_LLVM_MINGW_ROOT: llvmRoot,
          HORIZON_TRAVERSAL_MSYS2_ROOT: msysRoot,
          HORIZON_TRAVERSAL_NASM_ROOT: nasmRoot,
          HORIZON_TRAVERSAL_NATIVE_WORK_DIR: buildDirectory,
        },
      },
    );
  } finally {
    if (keepBuild) {
      console.log(`Build directory retained at ${temporaryDirectory}`);
    } else {
      await rm(temporaryDirectory, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 100,
      });
    }
  }
}

async function main() {
  if (process.platform === "darwin" && process.arch === "arm64") {
    const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
    const target = manifest.targets?.[MACOS_TARGET];
    if (!target) {
      fail(`native-assets.json has no output pins for ${MACOS_TARGET}`);
    }
    if (await preparedBinariesMatch(target, MACOS_TARGET)) {
      console.log(`FFmpeg and FFprobe are already prepared for ${MACOS_TARGET}.`);
      return;
    }
    await run("/bin/sh", [
      path.join(ROOT, "scripts", "build-native-macos-arm64.sh"),
    ]);
    return;
  }
  if (process.platform === "win32") {
    await prepareWindows();
    return;
  }

  fail(
    `FFmpeg preparation supports macOS arm64 and Windows x64; received ${process.platform}-${process.arch}`,
  );
}

main().catch((error) => {
  console.error(`FFmpeg preparation failed: ${error.message}`);
  process.exitCode = 1;
});
