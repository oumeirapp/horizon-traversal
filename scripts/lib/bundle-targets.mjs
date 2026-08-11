import path from "node:path";

export const PINNED_NODE_VERSION = "24.14.0";

export const BUNDLE_TARGETS = Object.freeze({
  macos: Object.freeze({
    platform: "darwin",
    architecture: "arm64",
    rustHost: "aarch64-apple-darwin",
    tauriArguments: Object.freeze([
      "build",
      "--target",
      "aarch64-apple-darwin",
      "--bundles",
      "app,dmg",
      "--ci",
    ]),
  }),
  windows: Object.freeze({
    platform: "win32",
    architecture: "x64",
    rustHost: "x86_64-pc-windows-msvc",
    tauriArguments: Object.freeze([
      "build",
      "--target",
      "x86_64-pc-windows-msvc",
      "--bundles",
      "nsis",
      "--ci",
      "--no-sign",
    ]),
  }),
});

const NOTARIZATION_ENVIRONMENT_VARIABLES = Object.freeze([
  "APPLE_ID",
  "APPLE_PASSWORD",
  "APPLE_TEAM_ID",
  "APPLE_API_KEY",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY_PATH",
]);

const CERTIFICATE_ENVIRONMENT_VARIABLES = Object.freeze([
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
]);

export function resolveBundleTarget(name) {
  const target = BUNDLE_TARGETS[name];
  if (!target) {
    throw new Error(
      `unknown bundle target ${JSON.stringify(name)}; expected macos or windows`,
    );
  }
  return target;
}

export function assertBundleEnvironment(
  name,
  {
    platform,
    architecture,
    rustHost,
    nodeVersion,
  },
) {
  const target = resolveBundleTarget(name);
  if (nodeVersion !== PINNED_NODE_VERSION) {
    throw new Error(
      `bundling requires Node ${PINNED_NODE_VERSION}; received ${nodeVersion}`,
    );
  }
  if (platform !== target.platform || architecture !== target.architecture) {
    throw new Error(
      `${name} bundling requires ${target.platform}-${target.architecture}; received ${platform}-${architecture}`,
    );
  }
  if (rustHost !== target.rustHost) {
    throw new Error(
      `${name} bundling requires rustc host ${target.rustHost}; received ${rustHost}`,
    );
  }
  return target;
}

export function bundleEnvironment(
  name,
  inheritedEnvironment,
  cargoTargetDirectory,
) {
  if (!path.isAbsolute(cargoTargetDirectory ?? "")) {
    throw new Error("bundle Cargo target directory must be absolute");
  }
  const environment = { ...inheritedEnvironment };
  for (const variable of Object.keys(environment)) {
    if (variable.toUpperCase() === "CARGO_TARGET_DIR") {
      delete environment[variable];
    }
  }
  environment.CARGO_TARGET_DIR = cargoTargetDirectory;
  if (name === "macos") {
    for (const variable of [
      ...NOTARIZATION_ENVIRONMENT_VARIABLES,
      ...CERTIFICATE_ENVIRONMENT_VARIABLES,
    ]) {
      delete environment[variable];
    }
    environment.APPLE_SIGNING_IDENTITY = "-";
  }
  return environment;
}
