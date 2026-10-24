// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { GET as derive } from "../app/api/dacs/derive/route.js";
import { GET as lookup } from "../app/api/dacs/lookup/route.js";
import { indexRegistration } from "../src/catalog/indexer.js";
import { loadScanState, saveCatalog, saveScanState } from "../src/catalog/store.js";
import { dids, locator, maps, seeds, vector, type Obj } from "./fixtures/current-evidence.js";

const ownerAddress = `0x${dids[1].slice(-64)}`;
const legacyFixture = JSON.parse(readFileSync(new URL("./fixtures/reviewbot-listing-anchor.json", import.meta.url), "utf8"));
const { signature: _unsigned, ...legacyOriginal } = legacyFixture.data;
const legacyScope = { ...legacyOriginal, agentId: dids[1] };
const legacySignature = Buffer.from(ed25519Sign(
  Buffer.from(`dacs-listing:v1:${contentHash(legacyScope)}`, "utf8"), privateKeyFromSeed(seeds[1]),
)).toString("base64url");

async function seedAnchors() {
  const current = await vector("title-job", 140);
  const legacyAt = locator(700);
  const unsignedAt = locator(701);
  maps.set(legacyAt, { ...legacyScope, signature: legacySignature });
  maps.set(unsignedAt, { ...legacyScope, serviceId: "unsigned-service" });
  return { currentAt: current.locators.listing, legacyAt, unsignedAt };
}

async function withChainReads<T>(run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const data = maps.get(String(input).split("/").pop() ?? "");
    return data
      ? Response.json({ success: true, owner: ownerAddress, programName: "dacs:test", data })
      : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("lookup lists a verified current and a verified legacy Listing by title and omits an unsigned one", async () => {
  const { currentAt, legacyAt, unsignedAt } = await seedAnchors();
  saveScanState({ ...loadScanState(), listings: { [currentAt]: ownerAddress, [legacyAt]: ownerAddress, [unsignedAt]: ownerAddress } });
  const response = await withChainReads(() => lookup(new NextRequest(`https://directory.example/api/dacs/lookup?claim=${dids[1]}`)));
  const { listings } = await response.json() as { listings: Array<{ address: string; title: string }> };
  assert.deepEqual(listings, [
    { address: currentAt, title: "test" },
    { address: legacyAt, title: legacyScope.name },
  ]);
});

test("derive returns the title of a verified current and of a verified legacy Listing, and none once the bytes change", async () => {
  const { currentAt, legacyAt } = await seedAnchors();
  const record = await withChainReads(() => indexRegistration(
    { primaryClaim: dids[1], displayName: "seller", listingAnchors: [currentAt, legacyAt], deals: [] },
    undefined, async () => { throw new Error("identity unavailable"); },
  ));
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [record] });
  const titleOf = async (serviceId: string) => {
    const response = await withChainReads(() => derive(new NextRequest(
      `https://directory.example/api/dacs/derive?claim=${dids[1]}&serviceId=${serviceId}`)));
    return (await response.json() as { title: string | null; valid: boolean });
  };
  assert.deepEqual(await titleOf("svc"), { address: currentAt, found: true, valid: true, ownedByClaim: true, title: "test" });
  assert.deepEqual(await titleOf(legacyScope.serviceId), { address: legacyAt, found: true, valid: true, ownedByClaim: true, title: legacyScope.name });
  const stored = maps.get(currentAt) as Obj;
  maps.set(currentAt, { ...stored, offering: { ...(stored.offering as Obj), title: "changed after signing" } });
  assert.deepEqual(await titleOf("svc"), { address: currentAt, found: true, valid: false, ownedByClaim: false, title: null });
});

test("lookup skips a stored Listing that is not stable canonical JSON instead of failing the lookup", async () => {
  const { currentAt, legacyAt } = await seedAnchors();
  const hostileAt = locator(702);
  saveScanState({ ...loadScanState(), listings: { [hostileAt]: ownerAddress, [currentAt]: ownerAddress, [legacyAt]: ownerAddress } });
  // 1e400 parses to Infinity, which the SDK refuses to canonicalize.
  const hostileBody = `{"success":true,"owner":"${ownerAddress}","programName":"dacs:test","data":${JSON.stringify(legacyScope).replace(/\}$/, ',"future":1e400}')}}`;
  const response = await withChainReads(async () => {
    const chainReads = globalThis.fetch;
    globalThis.fetch = async (input) => String(input).split("/").pop() === hostileAt
      ? new Response(hostileBody, { headers: { "content-type": "application/json" } })
      : chainReads(input);
    return lookup(new NextRequest(`https://directory.example/api/dacs/lookup?claim=${dids[1]}`));
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { listings: unknown }).listings, [
    { address: currentAt, title: "test" },
    { address: legacyAt, title: legacyScope.name },
  ]);
});
