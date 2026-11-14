import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";

let redirectedReads = 0;
const server = createServer((req, res) => {
  if (req.url === "/redirected") {
    redirectedReads++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ result: 200, response: [{ id: 17 }] }));
  } else {
    res.writeHead(307, { location: "/redirected" }); res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
process.env.DEMOS_RPC = `http://127.0.0.1:${address.port}`;
const data = mkdtempSync(join(tmpdir(), "dacs-rpc-limits-"));
process.env.DACS_DIRECTORY_DATA = data;
const { readChainTip } = await import("../src/catalog/scan.js");
const { gcrGetIdentities } = await import("../src/catalog/gcr.js");
const { GET } = await import("../app/api/dacs/status/route.js");
const { MAX_STORAGE_RESPONSE_BYTES, StorageResponseTooLarge } = await import("../src/catalog/artifactLimits.js");
test.after(() => { server.closeAllConnections(); server.close(); rmSync(data, { recursive: true, force: true }); });

test("chain reads reject a real HTTP redirect without visiting its target", async () => {
  await assert.rejects(readChainTip());
  assert.equal(redirectedReads, 0);
});

for (const kind of ["scan", "gcr", "status"] as const) {
  test(`${kind} caps a chunked node response before buffering all of it`, async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    let pulls = 0;
    const maxPulls = MAX_STORAGE_RESPONSE_BYTES / (64 * 1024) + 8;
    globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(new TextEncoder().encode('{"result":200,"response":[{"id":17}],"padding":"'));
        else if (pulls < maxPulls) controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        else { controller.enqueue(new TextEncoder().encode('"}')); controller.close(); }
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    try {
      if (kind === "scan") await assert.rejects(readChainTip(), StorageResponseTooLarge);
      else if (kind === "gcr") await assert.rejects(gcrGetIdentities("a".repeat(64)));
      else {
        const response = await GET(new NextRequest("https://directory.test/api/dacs/status"));
        assert.equal((await response.json()).chainLatestTx, null);
      }
      assert.equal(cancelled, true);
      assert.ok(pulls < maxPulls);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test("storage, GCR, finality, status and deployment probes stay on the configured node", async () => {
  const { readStorage } = await import("../src/catalog/scan.js");
  const { readAnchorResult } = await import("../src/catalog/chain.js");
  const { pinnedNodeDeployment } = await import("../src/catalog/listingFinality.js");
  const { probeNodeContract } = await import("../src/catalog/nodeContract.js");
  const locator = `stor-${"a".repeat(40)}`;
  assert.equal((await readStorage(locator, 1)).success, false);
  assert.equal((await readAnchorResult(locator)).status, "unavailable");
  await assert.rejects(gcrGetIdentities("a".repeat(64)));
  await assert.rejects(pinnedNodeDeployment());
  assert.equal((await (await GET(new NextRequest("https://directory.test/api/dacs/status"))).json()).chainLatestTx, null);
  assert.equal((await probeNodeContract(process.env.DEMOS_RPC!, "probe")).ok, false);
  assert.equal(redirectedReads, 0);
});

test("node replies at the ceiling remain readable; one extra byte is refused", async () => {
  const originalFetch = globalThis.fetch;
  const prefix = '{"result":200,"response":[{"id":17}],"padding":"';
  const suffix = '"}';
  const text = prefix + "x".repeat(MAX_STORAGE_RESPONSE_BYTES - prefix.length - suffix.length) + suffix;
  try {
    globalThis.fetch = async () => new Response(text);
    assert.equal(await readChainTip(), 17);
    assert.equal((await gcrGetIdentities("a".repeat(64)) as { result: number }).result, 200);
    assert.equal((await (await GET(new NextRequest("https://directory.test/api/dacs/status"))).json()).chainLatestTx, 17);
    globalThis.fetch = async () => new Response(text + " ");
    await assert.rejects(readChainTip(), StorageResponseTooLarge);
  } finally { globalThis.fetch = originalFetch; }
});
