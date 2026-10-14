import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

// The artifact proxy forwards `ref` to the node's storage-program path; only a native locator may reach it.
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-artifact-route-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { GET } = await import("../app/api/dacs/artifact/route.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const native = `stor-${"ab".repeat(20)}`;

test("the artifact proxy reads only a native storage locator and never forwards any other ref upstream", async () => {
  const requested: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return Response.json({ success: true, owner: `0x${"1".repeat(64)}`, programName: "opaque", data: { ok: true } });
  };
  try {
    const read = async (ref: string) => (await GET(new NextRequest(`http://localhost/api/dacs/artifact?ref=${encodeURIComponent(ref)}`))).json();
    for (const ref of [
      "../admin", "stor-../../admin", `${native}/../../admin`, `${native}?raw=1`, native.toUpperCase(),
      `stor-${"ab".repeat(19)}`, `${native}a`, ` ${native}`, `stor-${"ab".repeat(32)}`, "%2e%2e%2fadmin",
    ]) {
      assert.deepEqual(await read(ref), { ref, value: null }, ref);
    }
    assert.deepEqual(requested, [], "no invalid ref reaches the node");
    assert.deepEqual(await read(native), { ref: native, value: { ok: true } });
    assert.equal(requested.length, 1);
    assert.equal(new URL(requested[0]).pathname.replace(/^.*\/storage-program\//, ""), native);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
