import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The catalog store reads DACS_DIRECTORY_DATA once, when it is first imported,
// so this file sets one unusable path and checks both cases against it.
const scratchDir = mkdtempSync(join(tmpdir(), "dacs-health-bad-path-"));
const regularFile = join(scratchDir, "not-a-directory");
writeFileSync(regularFile, "plain file");
process.env.DACS_DIRECTORY_DATA = join(regularFile, "data");

const { GET } = await import("../app/api/health/route.js");
const unavailableBody = { ok: false, error: "catalog data directory is unavailable" };

test("the health route answers 503 when the data path is under a regular file", async () => {
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), unavailableBody);
});

test("the health route answers 503 when the data path is a regular file", async () => {
  process.env.DACS_DIRECTORY_DATA = regularFile;
  const response = await GET();
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), unavailableBody);
});
