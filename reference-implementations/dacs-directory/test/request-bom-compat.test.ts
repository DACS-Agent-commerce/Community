import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

const data = mkdtempSync(join(tmpdir(), "dacs-bom-"));
process.env.DACS_DIRECTORY_DATA = data;
process.env.DACS_ADMIN_TOKEN = "bom-test";
const { POST } = await import("../app/api/dacs/index-now/route.js");
test.after(() => rmSync(data, { recursive: true, force: true }));

test("index-now accepts BOM-prefixed JSON as Request.json did", async () => {
  const req = new NextRequest("https://directory.test/api/dacs/index-now", {
    method: "POST", headers: { authorization: "Bearer bom-test" },
    body: '\uFEFF{"claim":"unregistered-bom-claim"}',
  });
  assert.equal((await POST(req)).status, 404);
});
