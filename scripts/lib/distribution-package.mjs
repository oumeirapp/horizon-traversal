import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const SOURCE_ARCHIVE_NAME = "Horizon-Traversal-native-source.zip";
const NOTICE_NAME = "THIRD_PARTY_NOTICES.md";
const CHECKSUM_NAME = "SHA256SUMS";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const DISTRIBUTION_TARGETS = Object.freeze({
  macos: Object.freeze({
    artifactDirectory: Object.freeze([
      "aarch64-apple-darwin",
      "release",
      "bundle",
      "dmg",
    ]),
    artifactExtension: ".dmg",
    directoryName: "macos-aarch64",
  }),
  windows: Object.freeze({
    artifactDirectory: Object.freeze([
      "x86_64-pc-windows-msvc",
      "release",
      "bundle",
      "nsis",
    ]),
    artifactExtension: ".exe",
    directoryName: "windows-x64",
  }),
});

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolveTarget(targetName) {
  const target = DISTRIBUTION_TARGETS[targetName];
  if (!target) {
    throw new Error(
      `unknown distribution target ${JSON.stringify(targetName)}; expected macos or windows`,
    );
  }
  return target;
}

function assertSafeComponent(component, description) {
  if (
    typeof component !== "string" ||
    component.length === 0 ||
    component === "." ||
    component === ".." ||
    component.includes("/") ||
    component.includes("\\") ||
    /[\0-\x1f\x7f]/.test(component)
  ) {
    throw new Error(`${description} is not a safe path component: ${component}`);
  }
  return component;
}

function resolveInside(root, ...components) {
  for (const component of components) {
    assertSafeComponent(component, "path");
  }
  const resolvedRoot = path.resolve(root);
  const destination = path.resolve(resolvedRoot, ...components);
  const relative = path.relative(resolvedRoot, destination);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path does not resolve safely inside ${resolvedRoot}`);
  }
  return destination;
}

async function requireDirectory(directory, description) {
  let metadata;
  try {
    metadata = await lstat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${description} is missing: ${directory}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${description} is not a regular directory: ${directory}`);
  }
}

async function requireRegularFile(file, description) {
  let metadata;
  try {
    metadata = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`${description} is missing: ${file}`);
    }
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`${description} is not a regular file: ${file}`);
  }
}

async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function collectTree(directory, prefix = "") {
  await requireDirectory(directory, prefix ? `directory ${prefix}` : "directory");
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => comparePaths(left.name, right.name));

  const seenCaseInsensitiveNames = new Set();
  const directories = [];
  const files = [];
  for (const entry of entries) {
    assertSafeComponent(entry.name, "directory entry");
    const foldedName = entry.name.toLocaleLowerCase("en-US");
    if (seenCaseInsensitiveNames.has(foldedName)) {
      throw new Error(
        `case-insensitive path collision in ${directory}: ${entry.name}`,
      );
    }
    seenCaseInsensitiveNames.add(foldedName);

    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = path.join(directory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`symbolic links are not allowed in distributions: ${absolutePath}`);
    }
    if (metadata.isDirectory()) {
      directories.push(relativePath);
      const nested = await collectTree(absolutePath, relativePath);
      directories.push(...nested.directories);
      files.push(...nested.files);
    } else if (metadata.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`unsupported filesystem entry in distribution: ${absolutePath}`);
    }
  }

  return { directories, files };
}

async function locatePrimaryArtifact(cargoTargetDirectory, target) {
  if (!path.isAbsolute(cargoTargetDirectory ?? "")) {
    throw new Error("Cargo target directory must be absolute");
  }
  const artifactDirectory = path.join(
    cargoTargetDirectory,
    ...target.artifactDirectory,
  );
  await requireDirectory(artifactDirectory, "Tauri installer output directory");
  const entries = await readdir(artifactDirectory);
  const candidates = entries
    .filter((entry) =>
      entry.toLocaleLowerCase("en-US").endsWith(target.artifactExtension),
    )
    .sort(comparePaths);
  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one ${target.artifactExtension} installer in ${artifactDirectory}; found ${candidates.length}`,
    );
  }
  const artifactName = assertSafeComponent(candidates[0], "installer name");
  const artifactPath = path.join(artifactDirectory, artifactName);
  await requireRegularFile(artifactPath, "Tauri installer artifact");
  return { artifactName, artifactPath };
}

function parseChecksums(contents) {
  if (!contents.endsWith("\n") || contents.includes("\r")) {
    throw new Error("distribution SHA256SUMS must use LF endings and end in a newline");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    throw new Error("distribution SHA256SUMS is empty");
  }

  const checksums = new Map();
  let previousPath;
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match || !SHA256_PATTERN.test(match[1])) {
      throw new Error(`invalid distribution SHA256SUMS line: ${line}`);
    }
    const components = match[2].split("/");
    for (const component of components) {
      assertSafeComponent(component, "checksum path");
    }
    const relativePath = components.join("/");
    if (checksums.has(relativePath)) {
      throw new Error(`duplicate distribution SHA256SUMS path: ${relativePath}`);
    }
    if (previousPath !== undefined && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error("distribution SHA256SUMS paths are not sorted");
    }
    previousPath = relativePath;
    checksums.set(relativePath, match[1]);
  }
  return checksums;
}

function samePaths(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

async function sourceLayout(root, targetName, cargoTargetDirectory) {
  const target = resolveTarget(targetName);
  const artifact = await locatePrimaryArtifact(cargoTargetDirectory, target);
  const releaseDirectory = path.join(
    cargoTargetDirectory,
    "release-artifacts",
  );
  const archivePath = path.join(releaseDirectory, SOURCE_ARCHIVE_NAME);
  const noticePath = resolveInside(
    root,
    "src-tauri",
    "binaries",
    NOTICE_NAME,
  );
  const licensesDirectory = resolveInside(
    root,
    "src-tauri",
    "binaries",
    "licenses",
  );
  await requireRegularFile(archivePath, "verified native source archive");
  await requireRegularFile(noticePath, "third-party notices");
  const licenseTree = await collectTree(licensesDirectory, "licenses");
  if (licenseTree.files.length === 0) {
    throw new Error(`license directory is empty: ${licensesDirectory}`);
  }
  const licenses = {
    directories: ["licenses", ...licenseTree.directories],
    files: licenseTree.files,
  };

  return {
    artifact,
    archivePath,
    licenses,
    licensesDirectory,
    noticePath,
    releaseDirectory,
    target,
  };
}

async function copySourceLayout(layout, destination) {
  const copies = [
    [layout.artifact.artifactPath, layout.artifact.artifactName],
    [layout.archivePath, SOURCE_ARCHIVE_NAME],
    [layout.noticePath, NOTICE_NAME],
  ];
  for (const [source, relativePath] of copies) {
    await copyFile(source, path.join(destination, relativePath), 0);
    await chmod(path.join(destination, relativePath), 0o644);
  }

  for (const relativeDirectory of layout.licenses.directories) {
    await mkdir(path.join(destination, ...relativeDirectory.split("/")), {
      recursive: true,
      mode: 0o755,
    });
  }
  for (const relativeFile of layout.licenses.files) {
    const sourceRelative = relativeFile.slice("licenses/".length);
    const source = path.join(
      layout.licensesDirectory,
      ...sourceRelative.split("/"),
    );
    const destinationFile = path.join(destination, ...relativeFile.split("/"));
    await copyFile(source, destinationFile, 0);
    await chmod(destinationFile, 0o644);
  }
}

async function writeChecksums(directory, relativeFiles) {
  const lines = [];
  for (const relativePath of [...relativeFiles].sort(comparePaths)) {
    const digest = await sha256File(
      path.join(directory, ...relativePath.split("/")),
    );
    lines.push(`${digest}  ${relativePath}`);
  }
  await writeFile(path.join(directory, CHECKSUM_NAME), `${lines.join("\n")}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
}

export async function verifyDistribution({
  root,
  targetName,
  cargoTargetDirectory,
  directory,
}) {
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error(`refusing unsafe repository root: ${resolvedRoot}`);
  }
  await requireDirectory(resolvedRoot, "repository root");
  const layout = await sourceLayout(
    resolvedRoot,
    targetName,
    cargoTargetDirectory,
  );
  const expectedDirectory = resolveInside(
    layout.releaseDirectory,
    layout.target.directoryName,
  );
  const resolvedDirectory = path.resolve(directory ?? expectedDirectory);
  const relativeToRelease = path.relative(
    layout.releaseDirectory,
    resolvedDirectory,
  );
  if (
    !relativeToRelease ||
    relativeToRelease.startsWith("..") ||
    path.isAbsolute(relativeToRelease)
  ) {
    throw new Error(
      `distribution directory is outside release artifacts: ${resolvedDirectory}`,
    );
  }
  await requireDirectory(resolvedDirectory, "assembled distribution directory");

  const expectedFiles = [
    layout.artifact.artifactName,
    SOURCE_ARCHIVE_NAME,
    NOTICE_NAME,
    ...layout.licenses.files,
  ].sort(comparePaths);
  const expectedFilesWithChecksums = [...expectedFiles, CHECKSUM_NAME].sort(
    comparePaths,
  );
  const expectedDirectories = [...layout.licenses.directories].sort(comparePaths);
  const entries = await collectTree(resolvedDirectory);
  const actualFiles = [...entries.files].sort(comparePaths);
  const actualDirectories = [...entries.directories].sort(comparePaths);
  if (!samePaths(actualFiles, expectedFilesWithChecksums)) {
    throw new Error(
      `distribution files differ from the required set; expected ${expectedFilesWithChecksums.join(", ")}; received ${actualFiles.join(", ")}`,
    );
  }
  if (!samePaths(actualDirectories, expectedDirectories)) {
    throw new Error(
      `distribution directories differ from the required set; expected ${expectedDirectories.join(", ")}; received ${actualDirectories.join(", ")}`,
    );
  }

  const checksums = parseChecksums(
    await readFile(path.join(resolvedDirectory, CHECKSUM_NAME), "utf8"),
  );
  if (!samePaths([...checksums.keys()], expectedFiles)) {
    throw new Error("distribution SHA256SUMS does not list the exact required files");
  }

  const trustedFiles = new Map([
    [layout.artifact.artifactName, layout.artifact.artifactPath],
    [SOURCE_ARCHIVE_NAME, layout.archivePath],
    [NOTICE_NAME, layout.noticePath],
  ]);
  for (const relativeFile of layout.licenses.files) {
    trustedFiles.set(
      relativeFile,
      path.join(
        layout.licensesDirectory,
        ...relativeFile.slice("licenses/".length).split("/"),
      ),
    );
  }

  for (const relativeFile of expectedFiles) {
    const assembledPath = path.join(
      resolvedDirectory,
      ...relativeFile.split("/"),
    );
    const [trustedHash, assembledHash] = await Promise.all([
      sha256File(trustedFiles.get(relativeFile)),
      sha256File(assembledPath),
    ]);
    if (assembledHash !== trustedHash) {
      throw new Error(`assembled distribution file was altered: ${relativeFile}`);
    }
    if (checksums.get(relativeFile) !== assembledHash) {
      throw new Error(
        `distribution checksum mismatch for ${relativeFile}: expected ${checksums.get(relativeFile)}, received ${assembledHash}`,
      );
    }
  }

  return {
    artifact: path.join(resolvedDirectory, layout.artifact.artifactName),
    directory: resolvedDirectory,
    fileCount: expectedFiles.length,
  };
}

export async function assembleDistribution({
  root,
  targetName,
  cargoTargetDirectory,
}) {
  const resolvedRoot = path.resolve(root);
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error(`refusing unsafe repository root: ${resolvedRoot}`);
  }
  await requireDirectory(resolvedRoot, "repository root");
  const layout = await sourceLayout(
    resolvedRoot,
    targetName,
    cargoTargetDirectory,
  );
  const releaseDirectory = layout.releaseDirectory;
  try {
    await requireDirectory(releaseDirectory, "release artifacts directory");
  } catch (error) {
    if (!error.message.includes(" is missing: ")) {
      throw error;
    }
    await mkdir(releaseDirectory, { recursive: true, mode: 0o755 });
    await requireDirectory(
      releaseDirectory,
      "release artifacts directory",
    );
  }

  const outputDirectory = resolveInside(
    releaseDirectory,
    layout.target.directoryName,
  );
  const stagingDirectory = await mkdtemp(
    path.join(
      releaseDirectory,
      `.${layout.target.directoryName}.staging-`,
    ),
  );
  const backupDirectory = path.join(
    releaseDirectory,
    `.${layout.target.directoryName}.previous-${process.pid}-${randomUUID()}`,
  );
  let movedPrevious = false;
  let installedNew = false;

  async function rollback() {
    if (installedNew) {
      await rm(outputDirectory, { recursive: true, force: true });
      installedNew = false;
    }
    if (movedPrevious) {
      await rename(backupDirectory, outputDirectory);
      movedPrevious = false;
    }
  }

  try {
    await copySourceLayout(layout, stagingDirectory);
    const copiedFiles = [
      layout.artifact.artifactName,
      SOURCE_ARCHIVE_NAME,
      NOTICE_NAME,
      ...layout.licenses.files,
    ];
    await writeChecksums(stagingDirectory, copiedFiles);
    await verifyDistribution({
      root: resolvedRoot,
      targetName,
      cargoTargetDirectory,
      directory: stagingDirectory,
    });

    try {
      try {
        const existing = await lstat(outputDirectory);
        if (existing.isSymbolicLink() || !existing.isDirectory()) {
          throw new Error(
            `existing distribution is not a regular directory: ${outputDirectory}`,
          );
        }
        await rename(outputDirectory, backupDirectory);
        movedPrevious = true;
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }

      await rename(stagingDirectory, outputDirectory);
      installedNew = true;
      const result = await verifyDistribution({
        root: resolvedRoot,
        targetName,
        cargoTargetDirectory,
        directory: outputDirectory,
      });
      if (movedPrevious) {
        await rm(backupDirectory, { recursive: true, force: true });
        movedPrevious = false;
      }
      return result;
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "distribution installation and rollback both failed",
        );
      }
      throw error;
    }
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    if (!movedPrevious) {
      await rm(backupDirectory, { recursive: true, force: true });
    }
  }
}
