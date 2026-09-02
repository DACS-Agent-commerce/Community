import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "dacs-sdk");
const manifest = JSON.parse(readFileSync(join(root, "sdk-parity.json"), "utf8"));
const failures = [];

if (manifest.schemaVersion !== 1 || !/^[0-9a-f]{40}$/.test(manifest.sdkRevision ?? "")) {
  failures.push("sdk-parity.json has an invalid schema or SDK revision");
}

const profile = readFileSync(join(root, "src", "catalog", "sdkProfile.ts"), "utf8")
  .match(/DACS_SDK_REVISION\s*=\s*"([0-9a-f]{40})"/)?.[1];
const setup = readFileSync(join(root, "scripts", "setup-sdk.sh"), "utf8")
  .match(/SDK_REV="([0-9a-f]{40})"/)?.[1];

for (const [label, revision] of [["sdkProfile.ts", profile], ["setup-sdk.sh", setup]]) {
  if (revision !== manifest.sdkRevision) {
    failures.push(`${label} pins ${revision ?? "nothing"}; expected ${manifest.sdkRevision}`);
  }
}

let checkoutRevision;
try {
  checkoutRevision = execFileSync("git", ["-C", vendor, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
} catch {
  failures.push("vendored SDK checkout is missing; run npm run setup");
}
if (checkoutRevision && checkoutRevision !== manifest.sdkRevision) {
  failures.push(`vendored SDK is ${checkoutRevision}; expected ${manifest.sdkRevision}`);
}

const fingerprints = manifest.sourceFingerprints ?? {};
if (Object.keys(fingerprints).length === 0) {
  failures.push("parity manifest has no reviewed SDK source fingerprints");
}
for (const [relativePath, expected] of Object.entries(fingerprints)) {
  let actual;
  try {
    actual = createHash("sha256")
      .update(readFileSync(join(vendor, relativePath)))
      .digest("hex");
  } catch {
    failures.push(`reviewed SDK source is missing: ${relativePath}`);
    continue;
  }
  if (actual !== expected) {
    failures.push(`${relativePath} changed (${actual}); expected reviewed hash ${expected}`);
  }
}

if (!Array.isArray(manifest.coveredSurfaces) || manifest.coveredSurfaces.length === 0) {
  failures.push("parity manifest must declare covered surfaces");
}
if (!Array.isArray(manifest.deferredFailClosed)) {
  failures.push("parity manifest must declare fail-closed deferred surfaces");
}

if (failures.length > 0) {
  console.error("SDK parity gate failed:\n" + failures.map((failure) => `  - ${failure}`).join("\n"));
  console.error("\nReview the new SDK source, update compatibility tests, then update sdk-parity.json.");
  process.exit(1);
}

console.log(`SDK parity gate passed for ${manifest.sdkRevision}`);
console.log(`  reviewed source files: ${Object.keys(fingerprints).length}`);
console.log(`  covered surfaces: ${manifest.coveredSurfaces.length}`);
console.log(`  explicitly fail-closed surfaces: ${manifest.deferredFailClosed.length}`);
