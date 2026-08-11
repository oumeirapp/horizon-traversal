import { createHash, randomUUID } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import https from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const SUPPORTING_FILES = Object.freeze([
  "package.json",
  "package-lock.json",
  "scripts/build-native-macos-arm64.sh",
  "scripts/build-native-windows-x64.ps1",
  "scripts/prepare-ffmpeg.mjs",
  "src-tauri/native-assets.json",
  "src-tauri/binaries/README.md",
  "src-tauri/binaries/THIRD_PARTY_NOTICES.md",
  "src-tauri/binaries/licenses/GPL-2.0-or-later.txt",
  "src-tauri/binaries/licenses/windows/llvm-mingw/LICENSE.TXT",
  "src-tauri/binaries/licenses/windows/mingw-w64/COPYING",
  "src-tauri/binaries/licenses/windows/mingw-w64/COPYING.MinGW-w64-runtime.txt",
  "src-tauri/binaries/licenses/windows/mingw-w64/COPYING.MinGW-w64.txt",
  "src-tauri/binaries/licenses/windows/mingw-w64/COPYING.winpthreads.txt",
  "src-tauri/binaries/licenses/windows/mingw-w64/COPYING.winstorecompat.txt",
]);

const EXECUTABLE_SUPPORTING_FILES = new Set([
  "scripts/build-native-macos-arm64.sh",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const SOURCE_NAMES = Object.freeze(["ffmpeg", "x264"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_DOS_DATE_1980_01_01 = 0x0021;
const ZIP_LOCAL_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function comparePaths(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function crc32(contents) {
  let value = 0xffffffff;
  for (const byte of contents) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipMode(relativePath) {
  return EXECUTABLE_SUPPORTING_FILES.has(relativePath) ? 0o100755 : 0o100644;
}

function ensureSafeRelativePath(relativePath, description = "path") {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    /[\0-\x1f\x7f]/.test(relativePath) ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath)
  ) {
    throw new Error(`${description} is not a safe relative path: ${relativePath}`);
  }

  const components = relativePath.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 || component === "." || component === "..",
    ) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    throw new Error(`${description} is not a safe relative path: ${relativePath}`);
  }

  return relativePath;
}

function resolveInside(root, relativePath) {
  ensureSafeRelativePath(relativePath);
  const destination = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(path.resolve(root), destination);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`path escapes its root: ${relativePath}`);
  }
  return destination;
}

function assertHttpsUrl(value, description) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${description} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${description} must be an HTTPS URL without credentials: ${value}`);
  }
  return url;
}

function archiveFileName(source, sourceName) {
  const url = assertHttpsUrl(source.url, `${sourceName} source URL`);
  let fileName;
  try {
    fileName = decodeURIComponent(path.posix.basename(url.pathname));
  } catch {
    throw new Error(`${sourceName} source URL has an invalid encoded file name`);
  }
  if (
    !fileName ||
    fileName === "." ||
    fileName === ".." ||
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(fileName)
  ) {
    throw new Error(`${sourceName} source URL has no safe archive name: ${source.url}`);
  }
  return fileName;
}

function validateManifest(manifest) {
  if (manifest?.schemaVersion !== 2) {
    throw new Error(
      `unsupported native asset manifest schema: ${manifest?.schemaVersion}`,
    );
  }

  const sources = SOURCE_NAMES.map((sourceName) => {
    const source = manifest.sources?.[sourceName];
    if (!source || !SHA256_PATTERN.test(source.sha256 ?? "")) {
      throw new Error(
        `native-assets.json does not contain a valid ${sourceName} source checksum`,
      );
    }
    assertHttpsUrl(source.url, `${sourceName} source URL`);
    return {
      fileName: archiveFileName(source, sourceName),
      name: sourceName,
      sha256: source.sha256,
      url: source.url,
    };
  });

  const archiveNames = new Set(sources.map((source) => source.fileName.toLowerCase()));
  if (archiveNames.size !== sources.length) {
    throw new Error("native source archive names collide on a case-insensitive filesystem");
  }
  return sources;
}

export async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function fetchWithVerifiedRedirects(url, fetchImpl, signal) {
  let current = assertHttpsUrl(url, "download URL");
  const visited = new Set();

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (visited.has(current.href)) {
      throw new Error(`download redirect loop detected at ${current.href}`);
    }
    visited.add(current.href);

    const response = await fetchImpl(current, {
      headers: {
        accept: "application/octet-stream",
        "user-agent":
          "Mozilla/5.0 (compatible; Horizon-Traversal-native-source/0.1; +https://github.com/)",
      },
      redirect: "manual",
      signal,
    });
    const responseUrl = response.url
      ? assertHttpsUrl(response.url, "download response URL")
      : current;

    if (REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel();
      if (redirectCount === 5) {
        throw new Error(`download exceeded five redirects: ${url}`);
      }
      const location = response.headers?.get?.("location");
      if (!location) {
        throw new Error(`download redirect omitted Location: ${current.href}`);
      }
      current = assertHttpsUrl(
        new URL(location, responseUrl).href,
        "download redirect URL",
      );
      continue;
    }

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error(`download failed with HTTP ${response.status}: ${current.href}`);
    }
    if (responseUrl.href !== current.href) {
      await response.body.cancel();
      throw new Error(
        `fetch followed an unverified redirect from ${current.href} to ${responseUrl.href}`,
      );
    }
    return response;
  }

  throw new Error(`download exceeded five redirects: ${url}`);
}

function openHttpsResponse(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          accept: "application/octet-stream",
          "user-agent": "Horizon-Traversal-native-source/0.1",
        },
      },
      resolve,
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`download timed out after ${timeoutMs} ms: ${url}`));
    });
    request.once("error", reject);
  });
}

async function downloadWithNodeHttps(url, destination, timeoutMs) {
  let current = assertHttpsUrl(url, "download URL");
  const visited = new Set();

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    if (visited.has(current.href)) {
      throw new Error(`download redirect loop detected at ${current.href}`);
    }
    visited.add(current.href);
    const response = await openHttpsResponse(current, timeoutMs);
    const status = response.statusCode ?? 0;
    if (REDIRECT_STATUSES.has(status)) {
      response.resume();
      if (redirectCount === 5) {
        throw new Error(`download exceeded five redirects: ${url}`);
      }
      const location = response.headers.location;
      if (!location) {
        throw new Error(`download redirect omitted Location: ${current.href}`);
      }
      current = assertHttpsUrl(
        new URL(location, current).href,
        "download redirect URL",
      );
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new Error(`download failed with HTTP ${status}: ${current.href}`);
    }
    await pipeline(
      response,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    return;
  }

  throw new Error(`download exceeded five redirects: ${url}`);
}

export async function downloadVerified(
  source,
  destination,
  { fetchImpl, timeoutMs = 300_000 } = {},
) {
  const injectedFetch = fetchImpl !== undefined;
  const effectiveFetch = fetchImpl ?? globalThis.fetch;
  if (typeof effectiveFetch !== "function") {
    throw new Error("this Node runtime does not provide fetch");
  }
  if (!SHA256_PATTERN.test(source.sha256 ?? "")) {
    throw new Error(`invalid expected SHA-256 for ${source.url}`);
  }

  const partial = `${destination}.part`;
  await rm(partial, { force: true });
  let finalError;
  let useHttpsFallback = false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (useHttpsFallback) {
        await downloadWithNodeHttps(source.url, partial, timeoutMs);
      } else {
        const response = await fetchWithVerifiedRedirects(
          source.url,
          effectiveFetch,
          AbortSignal.timeout(timeoutMs),
        );
        await pipeline(
          Readable.fromWeb(response.body),
          createWriteStream(partial, { flags: "wx", mode: 0o600 }),
        );
      }
      const actualSha256 = await sha256File(partial);
      if (actualSha256 !== source.sha256) {
        throw new Error(
          `checksum mismatch for ${source.url}: expected ${source.sha256}, received ${actualSha256}`,
        );
      }
      await chmod(partial, 0o644);
      await rename(partial, destination);
      return;
    } catch (error) {
      finalError = error;
      await rm(partial, { force: true });
      if (!injectedFetch) {
        useHttpsFallback = true;
      }
    }
  }

  throw finalError;
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
    throw new Error(`${description} is not a regular, non-symlink file: ${file}`);
  }
}

async function readCanonicalTextFile(file, description, normalizeLineEndings) {
  const contents = await readFile(file);
  if (!isUtf8(contents)) {
    throw new Error(`${description} is not valid UTF-8 text: ${file}`);
  }
  const text = contents.toString("utf8");
  const normalized = normalizeLineEndings ? text.replaceAll("\r\n", "\n") : text;
  if (normalized.includes("\r")) {
    throw new Error(`${description} contains a non-deterministic carriage return: ${file}`);
  }
  return Buffer.from(normalized, "utf8");
}

async function copySupportingFile(root, stagingDirectory, relativePath) {
  ensureSafeRelativePath(relativePath, "supporting file path");
  const source = resolveInside(root, relativePath);
  await requireRegularFile(source, `supporting file ${relativePath}`);

  const canonicalRoot = await realpath(root);
  const canonicalSource = await realpath(source);
  const sourceRelative = path.relative(canonicalRoot, canonicalSource);
  if (sourceRelative.startsWith("..") || path.isAbsolute(sourceRelative)) {
    throw new Error(`supporting file escapes the repository: ${relativePath}`);
  }

  const destination = resolveInside(stagingDirectory, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  const mode = EXECUTABLE_SUPPORTING_FILES.has(relativePath) ? 0o755 : 0o644;
  await writeFile(
    destination,
    await readCanonicalTextFile(source, `supporting file ${relativePath}`, true),
    { mode },
  );
  await chmod(destination, mode);
}

function expectedOfferPaths(sources) {
  return [
    ...sources.map((source) => `sources/${source.fileName}`),
    ...SUPPORTING_FILES,
  ].sort(comparePaths);
}

async function collectOfferEntries(root) {
  const rootMetadata = await lstat(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`source-offer path is not a regular directory: ${root}`);
  }

  const files = [];
  const directories = [];
  async function visit(directory, relativeDirectory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      ensureSafeRelativePath(relativePath, "source-offer entry");
      const entryPath = resolveInside(root, relativePath);
      if (entry.isSymbolicLink()) {
        throw new Error(`source offer contains a symlink: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        directories.push(relativePath);
        await visit(entryPath, relativePath);
      } else if (entry.isFile()) {
        files.push(relativePath);
      } else {
        throw new Error(`source offer contains a non-regular entry: ${relativePath}`);
      }
    }
  }
  await visit(root, "");
  return { directories, files };
}

function requireZipUint32(value, description) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${description} exceeds the deterministic ZIP32 limit`);
  }
  return value;
}

function localZipHeader({ crc, nameLength, offset, size }) {
  requireZipUint32(offset, "ZIP local offset");
  requireZipUint32(size, "ZIP entry size");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(ZIP_LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(size, 18);
  header.writeUInt32LE(size, 22);
  header.writeUInt16LE(nameLength, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralZipHeader({ crc, mode, nameLength, offset, size }) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(ZIP_CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(ZIP_DOS_DATE_1980_01_01, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(size, 20);
  header.writeUInt32LE(size, 24);
  header.writeUInt16LE(nameLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((mode * 0x10000) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

export async function createDeterministicSourceOfferZip({
  offerDirectory,
  archivePath,
}) {
  const entries = await collectOfferEntries(offerDirectory);
  const files = [...entries.files].sort(comparePaths);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const relativePath of files) {
    const name = Buffer.from(relativePath, "utf8");
    if (name.length > 0xffff) {
      throw new Error(`ZIP entry name is too long: ${relativePath}`);
    }
    const contents = await readFile(resolveInside(offerDirectory, relativePath));
    const size = requireZipUint32(contents.length, `ZIP entry ${relativePath}`);
    const crc = crc32(contents);
    const localHeader = localZipHeader({
      crc,
      nameLength: name.length,
      offset,
      size,
    });
    localParts.push(localHeader, name, contents);
    centralParts.push(
      centralZipHeader({
        crc,
        mode: zipMode(relativePath),
        nameLength: name.length,
        offset,
        size,
      }),
      name,
    );
    offset = requireZipUint32(
      offset + localHeader.length + name.length + contents.length,
      "ZIP local data",
    );
  }

  if (files.length > 0xffff) {
    throw new Error("source offer contains too many files for deterministic ZIP32");
  }
  const centralOffset = offset;
  const centralSize = requireZipUint32(
    centralParts.reduce((total, part) => total + part.length, 0),
    "ZIP central directory",
  );
  const end = Buffer.alloc(22);
  end.writeUInt32LE(ZIP_END_SIGNATURE, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(archivePath, Buffer.concat([...localParts, ...centralParts, end]), {
    flag: "wx",
    mode: 0o644,
  });
}

function requireBufferRange(buffer, offset, length, description) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > buffer.length
  ) {
    throw new Error(`truncated or invalid ZIP ${description}`);
  }
}

export async function verifyDeterministicSourceOfferZip({
  offerDirectory,
  archivePath,
}) {
  await requireRegularFile(archivePath, "source-offer ZIP archive");
  const archive = await readFile(archivePath);
  if (archive.length < 22) {
    throw new Error("source-offer ZIP is truncated");
  }
  const endOffset = archive.length - 22;
  if (archive.readUInt32LE(endOffset) !== ZIP_END_SIGNATURE) {
    throw new Error("source-offer ZIP has no deterministic end record");
  }
  if (
    archive.readUInt16LE(endOffset + 4) !== 0 ||
    archive.readUInt16LE(endOffset + 6) !== 0 ||
    archive.readUInt16LE(endOffset + 20) !== 0
  ) {
    throw new Error("source-offer ZIP must be a single-disk archive without a comment");
  }
  const entryCount = archive.readUInt16LE(endOffset + 10);
  if (archive.readUInt16LE(endOffset + 8) !== entryCount) {
    throw new Error("source-offer ZIP entry counts do not match");
  }
  const centralSize = archive.readUInt32LE(endOffset + 12);
  const centralOffset = archive.readUInt32LE(endOffset + 16);
  if (centralOffset + centralSize !== endOffset) {
    throw new Error("source-offer ZIP central directory is not packed deterministically");
  }

  const offerEntries = await collectOfferEntries(offerDirectory);
  const expectedFiles = [...offerEntries.files].sort(comparePaths);
  if (entryCount !== expectedFiles.length) {
    throw new Error(
      `source-offer ZIP contains ${entryCount} entries; expected ${expectedFiles.length}`,
    );
  }

  const centralEntries = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index += 1) {
    requireBufferRange(archive, cursor, 46, "central header");
    if (archive.readUInt32LE(cursor) !== ZIP_CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`source-offer ZIP central entry ${index} has an invalid signature`);
    }
    const madeBy = archive.readUInt16LE(cursor + 4);
    const needed = archive.readUInt16LE(cursor + 6);
    const flags = archive.readUInt16LE(cursor + 8);
    const method = archive.readUInt16LE(cursor + 10);
    const time = archive.readUInt16LE(cursor + 12);
    const date = archive.readUInt16LE(cursor + 14);
    const crc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const size = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const disk = archive.readUInt16LE(cursor + 34);
    const internalAttributes = archive.readUInt16LE(cursor + 36);
    const externalAttributes = archive.readUInt32LE(cursor + 38);
    const localOffset = archive.readUInt32LE(cursor + 42);
    requireBufferRange(
      archive,
      cursor + 46,
      nameLength + extraLength + commentLength,
      "central entry name",
    );
    const relativePath = archive
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString("utf8");
    ensureSafeRelativePath(relativePath, "ZIP entry path");
    if (
      madeBy !== 0x0314 ||
      needed !== 20 ||
      flags !== ZIP_UTF8_FLAG ||
      method !== 0 ||
      time !== 0 ||
      date !== ZIP_DOS_DATE_1980_01_01 ||
      compressedSize !== size ||
      extraLength !== 0 ||
      commentLength !== 0 ||
      disk !== 0 ||
      internalAttributes !== 0 ||
      externalAttributes !== ((zipMode(relativePath) * 0x10000) >>> 0)
    ) {
      throw new Error(`source-offer ZIP entry is not deterministic: ${relativePath}`);
    }
    centralEntries.push({ crc, localOffset, relativePath, size });
    cursor += 46 + nameLength;
  }
  if (cursor !== endOffset) {
    throw new Error("source-offer ZIP central directory has trailing data");
  }
  if (!samePaths(centralEntries.map((entry) => entry.relativePath), expectedFiles)) {
    throw new Error("source-offer ZIP entries do not match the verified directory");
  }

  let expectedLocalOffset = 0;
  for (const entry of centralEntries) {
    if (entry.localOffset !== expectedLocalOffset) {
      throw new Error(`source-offer ZIP local entries are not packed: ${entry.relativePath}`);
    }
    requireBufferRange(archive, entry.localOffset, 30, "local header");
    if (archive.readUInt32LE(entry.localOffset) !== ZIP_LOCAL_HEADER_SIGNATURE) {
      throw new Error(`source-offer ZIP has an invalid local header: ${entry.relativePath}`);
    }
    const nameLength = archive.readUInt16LE(entry.localOffset + 26);
    const extraLength = archive.readUInt16LE(entry.localOffset + 28);
    requireBufferRange(
      archive,
      entry.localOffset + 30,
      nameLength + extraLength + entry.size,
      "local entry data",
    );
    const localName = archive
      .subarray(entry.localOffset + 30, entry.localOffset + 30 + nameLength)
      .toString("utf8");
    if (
      archive.readUInt16LE(entry.localOffset + 4) !== 20 ||
      archive.readUInt16LE(entry.localOffset + 6) !== ZIP_UTF8_FLAG ||
      archive.readUInt16LE(entry.localOffset + 8) !== 0 ||
      archive.readUInt16LE(entry.localOffset + 10) !== 0 ||
      archive.readUInt16LE(entry.localOffset + 12) !== ZIP_DOS_DATE_1980_01_01 ||
      archive.readUInt32LE(entry.localOffset + 14) !== entry.crc ||
      archive.readUInt32LE(entry.localOffset + 18) !== entry.size ||
      archive.readUInt32LE(entry.localOffset + 22) !== entry.size ||
      extraLength !== 0 ||
      localName !== entry.relativePath
    ) {
      throw new Error(`source-offer ZIP local entry is invalid: ${entry.relativePath}`);
    }
    const dataOffset = entry.localOffset + 30 + nameLength;
    const archivedContents = archive.subarray(dataOffset, dataOffset + entry.size);
    if (crc32(archivedContents) !== entry.crc) {
      throw new Error(`source-offer ZIP CRC mismatch: ${entry.relativePath}`);
    }
    const offeredContents = await readFile(
      resolveInside(offerDirectory, entry.relativePath),
    );
    if (!archivedContents.equals(offeredContents)) {
      throw new Error(
        `source-offer ZIP differs from the verified directory: ${entry.relativePath}`,
      );
    }
    expectedLocalOffset = dataOffset + entry.size;
  }
  if (expectedLocalOffset !== centralOffset) {
    throw new Error("source-offer ZIP local data has trailing bytes");
  }

  return {
    archivePath,
    fileCount: expectedFiles.length,
    sha256: await sha256File(archivePath),
  };
}

function expectedDirectories(expectedFiles) {
  const directories = new Set();
  for (const file of expectedFiles) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      directories.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  return [...directories].sort(comparePaths);
}

function parseChecksums(contents) {
  if (contents.includes("\r") || !contents.endsWith("\n")) {
    throw new Error("SHA256SUMS must use LF endings and end with a newline");
  }
  const lines = contents.slice(0, -1).split("\n");
  if (lines.length === 1 && lines[0] === "") {
    throw new Error("SHA256SUMS is empty");
  }

  const checksums = new Map();
  let previousPath;
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  (.+)$/.exec(line);
    if (!match) {
      throw new Error(`invalid SHA256SUMS line: ${line}`);
    }
    const relativePath = ensureSafeRelativePath(match[2], "checksum path");
    if (checksums.has(relativePath)) {
      throw new Error(`duplicate SHA256SUMS path: ${relativePath}`);
    }
    if (previousPath !== undefined && comparePaths(previousPath, relativePath) >= 0) {
      throw new Error("SHA256SUMS paths are not in deterministic byte order");
    }
    previousPath = relativePath;
    checksums.set(relativePath, match[1]);
  }
  return checksums;
}

function samePaths(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export async function verifyNativeSourceOffer({ root, offerDirectory }) {
  const manifestPath = resolveInside(root, "src-tauri/native-assets.json");
  await requireRegularFile(manifestPath, "trusted native asset manifest");
  const trustedManifestBytes = await readFile(manifestPath);
  const manifest = JSON.parse(trustedManifestBytes.toString("utf8"));
  const sources = validateManifest(manifest);
  const expectedFiles = expectedOfferPaths(sources);
  const expectedFilesWithChecksums = [...expectedFiles, "SHA256SUMS"].sort(
    comparePaths,
  );
  const entries = await collectOfferEntries(offerDirectory);
  const actualFiles = [...entries.files].sort(comparePaths);
  if (!samePaths(actualFiles, expectedFilesWithChecksums)) {
    throw new Error(
      `source-offer files differ from the required set; expected ${expectedFilesWithChecksums.join(", ")}; received ${actualFiles.join(", ")}`,
    );
  }

  const requiredDirectories = expectedDirectories(expectedFiles);
  const actualDirectories = [...entries.directories].sort(comparePaths);
  if (!samePaths(actualDirectories, requiredDirectories)) {
    throw new Error(
      `source-offer directories differ from the required set; expected ${requiredDirectories.join(", ")}; received ${actualDirectories.join(", ")}`,
    );
  }

  const checksumPath = resolveInside(offerDirectory, "SHA256SUMS");
  const checksums = parseChecksums(await readFile(checksumPath, "utf8"));
  if (!samePaths([...checksums.keys()], expectedFiles)) {
    throw new Error("SHA256SUMS does not list the exact required files");
  }

  for (const relativePath of SUPPORTING_FILES) {
    const trustedFile = resolveInside(root, relativePath);
    const offeredFile = resolveInside(offerDirectory, relativePath);
    await requireRegularFile(trustedFile, `trusted supporting file ${relativePath}`);
    const [trustedContents, offeredContents] = await Promise.all([
      readCanonicalTextFile(
        trustedFile,
        `trusted supporting file ${relativePath}`,
        true,
      ),
      readCanonicalTextFile(
        offeredFile,
        `source-offer supporting file ${relativePath}`,
        false,
      ),
    ]);
    if (!trustedContents.equals(offeredContents)) {
      throw new Error(`source-offer supporting file was altered: ${relativePath}`);
    }
  }

  const offeredManifest = await readCanonicalTextFile(
    resolveInside(offerDirectory, "src-tauri/native-assets.json"),
    "source-offer native asset manifest",
    false,
  );
  const canonicalTrustedManifest = Buffer.from(
    trustedManifestBytes.toString("utf8").replaceAll("\r\n", "\n"),
    "utf8",
  );
  if (!offeredManifest.equals(canonicalTrustedManifest)) {
    throw new Error("source-offer native-assets.json differs from the repository");
  }

  const sourceByPath = new Map(
    sources.map((source) => [`sources/${source.fileName}`, source]),
  );
  for (const relativePath of expectedFiles) {
    const actualHash = await sha256File(resolveInside(offerDirectory, relativePath));
    if (actualHash !== checksums.get(relativePath)) {
      throw new Error(
        `source-offer checksum mismatch for ${relativePath}: expected ${checksums.get(relativePath)}, received ${actualHash}`,
      );
    }
    const source = sourceByPath.get(relativePath);
    if (source && actualHash !== source.sha256) {
      throw new Error(
        `${source.name} archive does not match native-assets.json: expected ${source.sha256}, received ${actualHash}`,
      );
    }
  }

  return {
    directory: offerDirectory,
    fileCount: expectedFiles.length,
  };
}

async function buildOffer({ root, stagingDirectory, fetchImpl }) {
  const manifestPath = resolveInside(root, "src-tauri/native-assets.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sources = validateManifest(manifest);

  await mkdir(resolveInside(stagingDirectory, "sources"), { recursive: true });
  for (const source of sources) {
    await downloadVerified(
      source,
      resolveInside(stagingDirectory, `sources/${source.fileName}`),
      { fetchImpl },
    );
  }
  for (const relativePath of SUPPORTING_FILES) {
    await copySupportingFile(root, stagingDirectory, relativePath);
  }

  const checksumLines = [];
  for (const relativePath of expectedOfferPaths(sources)) {
    const digest = await sha256File(resolveInside(stagingDirectory, relativePath));
    checksumLines.push(`${digest}  ${relativePath}`);
  }
  await writeFile(
    resolveInside(stagingDirectory, "SHA256SUMS"),
    `${checksumLines.join("\n")}\n`,
    { mode: 0o644 },
  );
}

export async function prepareNativeSourceOffer({
  root,
  outputDirectory,
  archivePath,
  fetchImpl,
}) {
  const resolvedRoot = path.resolve(root);
  const resolvedOutput = path.resolve(outputDirectory);
  const outputParent = path.dirname(resolvedOutput);
  const resolvedArchive = path.resolve(
    archivePath ?? path.join(outputParent, "Horizon-Traversal-native-source.zip"),
  );
  if (
    resolvedOutput === path.parse(resolvedOutput).root ||
    resolvedOutput === resolvedRoot ||
    path.dirname(resolvedArchive) !== outputParent ||
    resolvedArchive === resolvedOutput
  ) {
    throw new Error(
      `refusing unsafe source-offer output paths: ${resolvedOutput}, ${resolvedArchive}`,
    );
  }

  await mkdir(outputParent, { recursive: true });
  const outputName = path.basename(resolvedOutput);
  const stagingDirectory = await mkdtemp(
    path.join(outputParent, `.${outputName}.staging-`),
  );
  const stagingArchive = path.join(
    outputParent,
    `.${path.basename(resolvedArchive)}.staging-${process.pid}-${randomUUID()}`,
  );
  const backupDirectory = path.join(
    outputParent,
    `.${outputName}.previous-${process.pid}-${randomUUID()}`,
  );
  const backupArchive = path.join(
    outputParent,
    `.${path.basename(resolvedArchive)}.previous-${process.pid}-${randomUUID()}`,
  );
  let movedPreviousDirectory = false;
  let movedPreviousArchive = false;
  let installedNewDirectory = false;
  let installedNewArchive = false;

  async function moveExisting(source, destination, expectedType) {
    try {
      const metadata = await lstat(source);
      const valid =
        !metadata.isSymbolicLink() &&
        (expectedType === "directory" ? metadata.isDirectory() : metadata.isFile());
      if (!valid) {
        throw new Error(
          `existing source-offer ${expectedType} is not regular: ${source}`,
        );
      }
      await rename(source, destination);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }

  async function rollback() {
    if (installedNewArchive) {
      await rm(resolvedArchive, { force: true });
      installedNewArchive = false;
    }
    if (installedNewDirectory) {
      await rm(resolvedOutput, { recursive: true, force: true });
      installedNewDirectory = false;
    }
    if (movedPreviousDirectory) {
      await rename(backupDirectory, resolvedOutput);
      movedPreviousDirectory = false;
    }
    if (movedPreviousArchive) {
      await rename(backupArchive, resolvedArchive);
      movedPreviousArchive = false;
    }
  }

  try {
    await buildOffer({ root: resolvedRoot, stagingDirectory, fetchImpl });
    const directoryResult = await verifyNativeSourceOffer({
      root: resolvedRoot,
      offerDirectory: stagingDirectory,
    });
    await createDeterministicSourceOfferZip({
      offerDirectory: stagingDirectory,
      archivePath: stagingArchive,
    });
    const archiveResult = await verifyDeterministicSourceOfferZip({
      offerDirectory: stagingDirectory,
      archivePath: stagingArchive,
    });

    try {
      movedPreviousDirectory = await moveExisting(
        resolvedOutput,
        backupDirectory,
        "directory",
      );
      movedPreviousArchive = await moveExisting(
        resolvedArchive,
        backupArchive,
        "archive",
      );
      await rename(stagingDirectory, resolvedOutput);
      installedNewDirectory = true;
      await rename(stagingArchive, resolvedArchive);
      installedNewArchive = true;

      await verifyNativeSourceOffer({
        root: resolvedRoot,
        offerDirectory: resolvedOutput,
      });
      await verifyDeterministicSourceOfferZip({
        offerDirectory: resolvedOutput,
        archivePath: resolvedArchive,
      });
    } catch (error) {
      try {
        await rollback();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "source-offer installation and rollback both failed",
        );
      }
      throw error;
    }

    if (movedPreviousDirectory) {
      await rm(backupDirectory, { recursive: true, force: true });
      movedPreviousDirectory = false;
    }
    if (movedPreviousArchive) {
      await rm(backupArchive, { force: true });
      movedPreviousArchive = false;
    }
    return {
      ...directoryResult,
      archivePath: resolvedArchive,
      archiveSha256: archiveResult.sha256,
      directory: resolvedOutput,
    };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
    await rm(stagingArchive, { force: true });
  }
}
