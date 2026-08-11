import path from "node:path";
import { fileURLToPath } from "node:url";

import { prepareNativeSourceOffer } from "./lib/native-source-offer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_ROOT = path.join(
  ROOT,
  "src-tauri",
  "target",
  "release-artifacts",
);
const OUTPUT = path.join(RELEASE_ROOT, "native-source-offer");
const ARCHIVE = path.join(RELEASE_ROOT, "Horizon-Traversal-native-source.zip");

async function main() {
  const result = await prepareNativeSourceOffer({
    root: ROOT,
    outputDirectory: OUTPUT,
    archivePath: ARCHIVE,
  });
  console.log(
    `Prepared and verified ${result.fileCount} corresponding-source files at ${result.directory}`,
  );
  console.log(`Created ${result.archivePath} (SHA-256 ${result.archiveSha256})`);
}

main().catch((error) => {
  console.error(`Native source-offer preparation failed: ${error.message}`);
  process.exitCode = 1;
});
