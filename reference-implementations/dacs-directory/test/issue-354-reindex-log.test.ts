import assert from "node:assert/strict";
import test from "node:test";
import "./fixtures/isolated-data-dir.js";
import { reindexAll } from "../src/catalog/reindexCore.js";
import { saveRegistrations } from "../src/catalog/store.js";
import { fixtureCommitments } from "./fixtures/commitment-proof.js";
import { vector, maps, dids, registeredDeal, bindingFor } from "./fixtures/current-evidence.js";
import { onPinnedChain } from "./fixtures/pinned-node.js";

// Community #354: the reindex output names a refused bundle's job, role, locator and reason.
test("#354 reindex log says why a bundle side was refused", async (t) => {
  const fixture = await vector("issue-354-reindex", 9500);
  // The seller copy has no signatures, so its evidence graph fails.
  const seller = { ...fixture.sellerBundle, signatures: [] };
  maps.set(fixture.locators.seller, seller);
  const deal = registeredDeal("issue-354-reindex", fixture.locators.buyer, fixture.locators.seller);
  saveRegistrations([{ primaryClaim: dids[1], displayName: "seller", listingAnchors: [fixture.locators.listing], deals: [deal],
    bundleBindings: [
      await bindingFor(deal.jobId, "buyer", fixture.locators.buyer, fixture.buyerBundle, 0),
      await bindingFor(deal.jobId, "seller", fixture.locators.seller, seller, 1),
    ] }]);
  t.mock.method(globalThis, "fetch", async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.includes("/storage-program/")) {
      const data = maps.get(url.split("/").pop() ?? "");
      return new Response(JSON.stringify(data ? { success: true, owner: `0x${dids[1].slice(-64)}`, programName: "dacs:test", data } : { success: false }),
        { status: data ? 200 : 404, headers: { "content-type": "application/json" } });
    }
    return Response.json({ result: 200, response: [] });
  });
  const lines: string[] = [];
  await reindexAll({ nodeDeployment: onPinnedChain, log: (line) => lines.push(line), resolveIdentities: async () => [],
    commitment: fixtureCommitments });
  assert.ok(lines.some((line) => line.includes("deals=1 verified=0")), "the pass indexed the deal and left it unverified");
  const refused = lines.filter((line) => line.includes("bundle refused"));
  assert.deepEqual(refused, [
    `  bundle refused: job ${deal.jobId} seller copy at ${fixture.locators.seller}: required current bundle signatures are missing or invalid`,
  ], lines.join("\n"));
});
