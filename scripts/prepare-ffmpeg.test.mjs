import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { preparedBinariesReady } from "./prepare-ffmpeg.mjs";

const VERSION = "8.1.2";

function targetFixture() {
  return {
    ffmpeg: {
      path: "bin/ffmpeg",
      sha256: "not-a-release-hash",
      version: VERSION,
      requiredConfiguration: ["--enable-gpl", "--enable-libx264"],
      requiredEncoders: ["libx264", "aac"],
    },
    ffprobe: {
      path: "bin/ffprobe",
      sha256: "also-not-a-release-hash",
      version: VERSION,
    },
  };
}

function semanticCapture(overrides = {}) {
  return (binary, args) => {
    const program = path.basename(binary);
    const operation = args.at(-1);
    const override = overrides[`${program}:${operation}`];
    if (override !== undefined) {
      return override;
    }
    if (operation === "-version") {
      return `${program} version ${VERSION} Copyright fixture\nconfiguration: --enable-gpl --enable-libx264`;
    }
    return " V....D libx264 fixture encoder\n A....D aac fixture encoder";
  };
}

async function withRegularFixtures(callback) {
  const root = await mkdtemp(path.join(tmpdir(), "prepare-ffmpeg-test-"));
  try {
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "ffmpeg"), "fixture\n");
    await writeFile(path.join(root, "bin", "ffprobe"), "fixture\n");
    await chmod(path.join(root, "bin", "ffmpeg"), 0o755);
    await chmod(path.join(root, "bin", "ffprobe"), 0o755);
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("prepared binaries are accepted by semantics without output hashes", async () => {
  await withRegularFixtures(async (root) => {
    assert.equal(
      await preparedBinariesReady(targetFixture(), root, semanticCapture()),
      true,
    );
  });
});

test("prepared binaries must be regular files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "prepare-ffmpeg-test-"));
  try {
    await mkdir(path.join(root, "bin"));
    await writeFile(path.join(root, "bin", "ffmpeg"), "fixture\n");
    await chmod(path.join(root, "bin", "ffmpeg"), 0o755);
    await mkdir(path.join(root, "bin", "ffprobe"));
    assert.equal(
      await preparedBinariesReady(targetFixture(), root, semanticCapture()),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "prepared binaries must not be symbolic links",
  { skip: process.platform === "win32" },
  async () => {
    await withRegularFixtures(async (root) => {
      const target = targetFixture();
      const link = path.join(root, "bin", "ffmpeg-link");
      await symlink(path.join(root, "bin", "ffmpeg"), link);
      target.ffmpeg.path = "bin/ffmpeg-link";
      assert.equal(
        await preparedBinariesReady(target, root, semanticCapture()),
        false,
      );
    });
  },
);

test(
  "prepared binaries must be executable outside Windows",
  { skip: process.platform === "win32" },
  async () => {
    await withRegularFixtures(async (root) => {
      await chmod(path.join(root, "bin", "ffprobe"), 0o644);
      assert.equal(
        await preparedBinariesReady(targetFixture(), root, semanticCapture()),
        false,
      );
    });
  },
);

test("prepared binaries must report the pinned version and configuration", async () => {
  await withRegularFixtures(async (root) => {
    assert.equal(
      await preparedBinariesReady(
        targetFixture(),
        root,
        semanticCapture({
          "ffprobe:-version": "ffprobe version 8.1.1 Copyright fixture",
        }),
      ),
      false,
    );
    assert.equal(
      await preparedBinariesReady(
        targetFixture(),
        root,
        semanticCapture({
          "ffmpeg:-version":
            "ffmpeg version 8.1.2 Copyright fixture\nconfiguration: --enable-gpl",
        }),
      ),
      false,
    );
    assert.equal(
      await preparedBinariesReady(
        targetFixture(),
        root,
        semanticCapture({
          "ffprobe:-version":
            "ffprobe version 8.1.2 Copyright fixture\nconfiguration: --enable-gpl",
        }),
      ),
      false,
    );
  });
});

test("prepared FFmpeg must expose every required encoder", async () => {
  await withRegularFixtures(async (root) => {
    assert.equal(
      await preparedBinariesReady(
        targetFixture(),
        root,
        semanticCapture({
          "ffmpeg:-encoders": " V....D libx264 fixture encoder",
        }),
      ),
      false,
    );
  });
});
