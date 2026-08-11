import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SUPPORTING_FILES,
  downloadVerified,
  prepareNativeSourceOffer,
  verifyDeterministicSourceOfferZip,
  verifyNativeSourceOffer,
} from "./native-source-offer.mjs";

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

async function writeRelative(root, relativePath, contents) {
  const destination = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, contents);
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "horizon-source-offer-test-"));
  const ffmpeg = Buffer.from("fixture ffmpeg source\n");
  const x264 = Buffer.from("fixture x264 source\n");
  const manifest = {
    schemaVersion: 2,
    sources: {
      ffmpeg: {
        url: "https://sources.test/ffmpeg-fixture.tar.xz",
        sha256: sha256(ffmpeg),
      },
      x264: {
        url: "https://sources.test/x264-fixture.tar.bz2",
        sha256: sha256(x264),
      },
    },
  };

  for (const relativePath of SUPPORTING_FILES) {
    const contents =
      relativePath === "src-tauri/native-assets.json"
        ? `${JSON.stringify(manifest, null, 2)}\n`
        : `fixture for ${relativePath}\n`;
    await writeRelative(root, relativePath, contents);
  }

  const responses = new Map([
    [manifest.sources.ffmpeg.url, ffmpeg],
    [manifest.sources.x264.url, x264],
  ]);
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "manual");
    const body = responses.get(String(url));
    return body
      ? new Response(body, { status: 200 })
      : new Response("not found", { status: 404 });
  };

  const output = path.join(root, "dist", "native-source-offer");
  return {
    fetchImpl,
    ffmpeg,
    manifest,
    output,
    outputDirectory: output,
    root,
    x264,
  };
}

test("prepares a deterministic, clean, verifiable source offer", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  await mkdir(fixture.output, { recursive: true });
  await writeFile(path.join(fixture.output, "stale.txt"), "stale\n");
  await writeRelative(
    fixture.root,
    "src-tauri/binaries/README.md",
    "checkout with Windows line endings\r\n",
  );
  const first = await prepareNativeSourceOffer(fixture);
  assert.equal(first.fileCount, SUPPORTING_FILES.length + 2);
  await assert.rejects(readFile(path.join(fixture.output, "stale.txt")), {
    code: "ENOENT",
  });

  const firstChecksums = await readFile(
    path.join(fixture.output, "SHA256SUMS"),
    "utf8",
  );
  assert.match(firstChecksums, /sources\/ffmpeg-fixture\.tar\.xz/);
  assert.match(firstChecksums, /scripts\/build-native-windows-x64\.ps1/);
  assert.doesNotMatch(firstChecksums, /\\/);
  assert.equal(
    await readFile(
      path.join(fixture.output, "src-tauri", "binaries", "README.md"),
      "utf8",
    ),
    "checkout with Windows line endings\n",
  );
  const archivePath = path.join(
    fixture.root,
    "dist",
    "Horizon-Traversal-native-source.zip",
  );
  const firstArchive = await readFile(archivePath);
  const archive = await verifyDeterministicSourceOfferZip({
    offerDirectory: fixture.output,
    archivePath,
  });
  assert.equal(archive.fileCount, SUPPORTING_FILES.length + 3);

  await prepareNativeSourceOffer(fixture);
  assert.equal(
    await readFile(path.join(fixture.output, "SHA256SUMS"), "utf8"),
    firstChecksums,
  );
  assert.deepEqual(await readFile(archivePath), firstArchive);
  await verifyNativeSourceOffer({
    root: fixture.root,
    offerDirectory: fixture.output,
  });
});

test("ZIP verification rejects archive tampering", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await prepareNativeSourceOffer(fixture);
  const archivePath = path.join(
    fixture.root,
    "dist",
    "Horizon-Traversal-native-source.zip",
  );
  const archive = await readFile(archivePath);
  archive[40] ^= 0xff;
  await writeFile(archivePath, archive);
  await assert.rejects(
    verifyDeterministicSourceOfferZip({
      offerDirectory: fixture.output,
      archivePath,
    }),
    /invalid|differs|CRC mismatch|does not match|truncated/,
  );
});

test("verification rejects tampered and missing files", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await prepareNativeSourceOffer(fixture);

  const archive = path.join(
    fixture.output,
    "sources",
    "ffmpeg-fixture.tar.xz",
  );
  await writeFile(archive, "tampered\n");
  await assert.rejects(
    verifyNativeSourceOffer({
      root: fixture.root,
      offerDirectory: fixture.output,
    }),
    /checksum mismatch|does not match native-assets\.json/,
  );

  await rm(archive);
  await assert.rejects(
    verifyNativeSourceOffer({
      root: fixture.root,
      offerDirectory: fixture.output,
    }),
    /files differ from the required set/,
  );
});

test("verification rejects unsafe checksum paths", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await prepareNativeSourceOffer(fixture);

  const checksumsPath = path.join(fixture.output, "SHA256SUMS");
  const checksums = await readFile(checksumsPath, "utf8");
  await writeFile(
    checksumsPath,
    checksums.replace("package-lock.json", "../package-lock.json"),
  );
  await assert.rejects(
    verifyNativeSourceOffer({
      root: fixture.root,
      offerDirectory: fixture.output,
    }),
    /not a safe relative path/,
  );
});

test("downloads reject redirects away from HTTPS", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "horizon-source-download-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response(null, {
      status: 302,
      headers: { location: "http://insecure.test/archive.tar.xz" },
    });
  };

  await assert.rejects(
    downloadVerified(
      {
        url: "https://sources.test/archive.tar.xz",
        sha256: "0".repeat(64),
      },
      path.join(directory, "archive.tar.xz"),
      { fetchImpl },
    ),
    /must be an HTTPS URL/,
  );
  assert.equal(calls, 3);
});

test("downloads follow a verified relative HTTPS redirect", async (t) => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "horizon-source-redirect-test-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = Buffer.from("redirected source\n");
  const visited = [];
  const fetchImpl = async (url) => {
    visited.push(String(url));
    return String(url) === "https://sources.test/start"
      ? new Response(null, {
          status: 302,
          headers: { location: "/archive.tar.xz" },
        })
      : new Response(contents, { status: 200 });
  };
  const destination = path.join(directory, "archive.tar.xz");
  await downloadVerified(
    {
      url: "https://sources.test/start",
      sha256: sha256(contents),
    },
    destination,
    { fetchImpl },
  );
  assert.deepEqual(visited, [
    "https://sources.test/start",
    "https://sources.test/archive.tar.xz",
  ]);
  assert.deepEqual(await readFile(destination), contents);
});

test("failed preparation preserves the previous complete output", async (t) => {
  const fixture = await createFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await mkdir(fixture.output, { recursive: true });
  const marker = path.join(fixture.output, "previous.txt");
  await writeFile(marker, "previous complete output\n");

  await assert.rejects(
    prepareNativeSourceOffer({
      ...fixture,
      fetchImpl: async () => new Response("offline", { status: 503 }),
    }),
    /download failed with HTTP 503/,
  );
  assert.equal(await readFile(marker, "utf8"), "previous complete output\n");
});
