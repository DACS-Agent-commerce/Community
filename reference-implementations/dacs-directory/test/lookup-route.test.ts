import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

process.env.DACS_DIRECTORY_DATA = mkdtempSync(join(tmpdir(), "dacs-directory-lookup-route-"));
process.env.DEMOS_RPC = "https://node.test";
const store = await import("../src/catalog/store.js");
const { GET } = await import("../app/api/dacs/lookup/route.js");

const hex = "ab".repeat(32);
const locator = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const legacyListing = (name: string) => ({
  listingId: name, listingVersion: 1, agentId: `did:demos:agent:${hex}`, serviceId: name, name, description: "Legacy service",
  claimRequirements: [], supportedNegotiation: ["negotiate-fixed-price"], supportedPaymentRails: ["pay-dem"], supportedDelivery: ["deliver-attested-payload"],
});

test("a stored listing that is not stable canonical JSON is skipped instead of failing the lookup", async () => {
  store.saveScanState({ ...store.loadScanState(), listings: { [locator(1)]: `0x${hex}`, [locator(2)]: `0x${hex}` } });
  const stored: Record<string, string> = {
    // 1e400 parses to Infinity, which the SDK refuses to canonicalize.
    [locator(1)]: JSON.stringify(legacyListing("hostile")).replace(/}$/, ',"future":1e400}'),
    [locator(2)]: JSON.stringify(legacyListing("readable")),
  };
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = stored[new URL(String(input)).pathname.split("/").pop() ?? ""];
    return data === undefined ? new Response(null, { status: 503 })
      : new Response(`{"success":true,"owner":"0x${hex}","programName":"opaque","data":${data}}`, { headers: { "content-type": "application/json" } });
  };
  try {
    const response = await GET(new NextRequest(`http://localhost/api/dacs/lookup?claim=did:demos:agent:${hex}`));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).listings, [{ address: locator(2), title: "readable" }]);
  } finally { globalThis.fetch = original; }
});
