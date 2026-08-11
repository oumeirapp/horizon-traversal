import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyDeterministicSourceOfferZip,
  verifyNativeSourceOffer,
} from "./lib/native-source-offer.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_ROOT = path.join(
  ROOT,
  "src-tauri",
  "target",
  "release-artifacts",
);
const DEFAULT_OFFER = path.join(RELEASE_ROOT, "native-source-offer");
const DEFAULT_ARCHIVE = path.join(
  RELEASE_ROOT,
  "Horizon-Traversal-native-source.zip",
);

async function main() {
  if (process.argv.length > 4) {
    throw new Error(
      "usage: node scripts/verify-native-source-offer.mjs [source-offer-directory] [source-offer-zip]",
    );
  }
  const offerDirectory = process.argv[2]
    ? path.resolve(process.argv[2])
    : DEFAULT_OFFER;
  const archivePath = process.argv[3]
    ? path.resolve(process.argv[3])
    : DEFAULT_ARCHIVE;
  const result = await verifyNativeSourceOffer({
    root: ROOT,
    offerDirectory,
  });
  const archive = await verifyDeterministicSourceOfferZip({
    offerDirectory,
    archivePath,
  });
  console.log(
    `Verified ${result.fileCount} corresponding-source files at ${result.directory}`,
  );
  console.log(`Verified ${archive.archivePath} (SHA-256 ${archive.sha256})`);
}

main().catch((error) => {
  console.error(`Native source-offer verification failed: ${error.message}`);
  process.exitCode = 1;
});
