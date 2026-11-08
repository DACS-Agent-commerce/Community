import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The catalog store reads DACS_DIRECTORY_DATA once, when it is first imported.
process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-health-"));

const { GET } = await import("../app/api/health/route.js");

test("the health route answers 200 with the catalog time when the data path is usable", async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(Number.isSafeInteger(body.catalogGeneratedAt), true);
});
