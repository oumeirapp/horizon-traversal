import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PINNED_NODE_VERSION = "24.14.0";

function fail(message) {
  throw new Error(message);
}

export function assertNode24(version = process.versions.node) {
  if (version !== PINNED_NODE_VERSION) {
    fail(`package smoke requires Node ${PINNED_NODE_VERSION}; received ${version}`);
  }
}

export function resolveSmokeRunner({
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
} = {}) {
  if (platform === "darwin" && architecture === "arm64") {
    return {
      program: "sh",
      args: [path.join(SCRIPT_DIRECTORY, "build-and-run-macos-arm64.sh")],
    };
  }

  if (platform === "win32" && architecture === "x64") {
    const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
    if (!systemRoot) {
      fail("SystemRoot is unavailable; cannot locate Windows PowerShell 5.1");
    }
    return {
      program: path.win32.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        platform === process.platform
          ? path.join(SCRIPT_DIRECTORY, "build-and-run-windows-x64.ps1")
          : path.win32.join(
              "scripts",
              "smoke",
              "build-and-run-windows-x64.ps1",
            ),
      ],
    };
  }

  fail(
    `package smoke supports only macOS arm64 and Windows x64; received ${platform}/${architecture}`,
  );
}

export function runPackageSmoke(options = {}) {
  assertNode24(options.nodeVersion);
  const runner = resolveSmokeRunner(options);
  if (path.isAbsolute(runner.program) && !existsSync(runner.program)) {
    fail(`package smoke runner is unavailable: ${runner.program}`);
  }
  const result = spawnSync(runner.program, runner.args, {
    cwd: path.resolve(SCRIPT_DIRECTORY, "../.."),
    env: options.environment ?? process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) {
    fail(`could not start package smoke runner: ${result.error.message}`);
  }
  if (result.signal) {
    fail(`package smoke runner was terminated by signal ${result.signal}`);
  }
  if (result.status !== 0) {
    fail(`package smoke runner exited with status ${result.status}`);
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    runPackageSmoke();
  } catch (error) {
    console.error(`Package smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
