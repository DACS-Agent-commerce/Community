import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";

import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { listingPresentation } from "../src/catalog/listingMetadata.js";
import { PUBLISHABLE_RAIL_OPTIONS, RAIL_ID_PATTERN } from "../src/catalog/listingOptions.js";
import { resolveListingRails } from "../src/sdkListingValidation.js";

const dataDir = mkdtempSync(join(tmpdir(), "dacs-rail-registry-"));
process.env.DACS_DIRECTORY_DATA = join(dataDir, "directory.sqlite");
const { POST } = await import("../app/api/dacs/build-listing/route.js");
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

// An independent copy of DACS-4 §9.4.2 at the pinned Standard revision; the
// Directory's own table is never used as the oracle here.
const registry = JSON.parse(readFileSync(new URL("./fixtures/dacs4-v0.1-rail-registry.json", import.meta.url), "utf8")) as {
  standardRevision: string;
  rails: Array<{ railId: string; phaseHandler: string }>;
};
const standardDefinitions = registry.rails.map((rail) => ({
  railId: rail.railId,
  railVersion: 1,
  phaseHandler: rail.phaseHandler,
  governanceAnchoring: "in-code",
  signatureValid: true,
}));
const resolveAgainstStandard = (listing: { pipeline: Array<{ kind: string; parameters?: Record<string, unknown> }>; acceptedRails: unknown[] }) =>
  resolveListingRails({
    trustPhase: "PA-1",
    trustPolicyAcceptsPA1: true,
    payPhases: listing.pipeline.filter((phase) => phase.kind.startsWith("pay-"))
      .map((phase) => ({ kind: phase.kind, rail: phase.parameters?.rail })),
    acceptedRails: listing.acceptedRails as never,
    registry: { state: "not-used", entries: [], definitions: [] },
    inCodeDefinitions: standardDefinitions,
  });

test("every publishable rail is a DACS-4 §9.4.2 registry ID with its registered phase handler", () => {
  assert.equal(registry.standardRevision, "d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20");
  assert.equal(registry.rails.length, 13);
  for (const option of PUBLISHABLE_RAIL_OPTIONS) {
    const entry = registry.rails.find((rail) => rail.railId === option.railId);
    assert.ok(entry, `${option.railId} is in the registry`);
    assert.equal(option.phaseKind, entry.phaseHandler, option.railId);
  }
  for (const rail of registry.rails) assert.match(rail.railId, RAIL_ID_PATTERN, rail.railId);
  for (const handler of ["pay-dem", "pay-x402", "pay-ap2"]) {
    assert.doesNotMatch(handler, RAIL_ID_PATTERN, `${handler} is a phase handler, not a rail ID`);
  }
});

test("a /register-built Listing verifies under a reader using the Standard registry", async () => {
  const seed = Uint8Array.from(Buffer.alloc(32, 31));
  const privateKey = privateKeyFromSeed(seed);
  const claim = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
  const request = (body: Record<string, unknown>) => new NextRequest("https://directory.example/api/dacs/build-listing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => init?.method === "POST"
    ? Response.json({ result: 200, response: JSON.parse(String(init.body)).params?.[0]?.message === "searchStoragePrograms" ? [] : 0 })
    : new Response(null, { status: 404 });
  try {
    for (const option of PUBLISHABLE_RAIL_OPTIONS) {
      const base = {
        claim,
        serviceId: `svc-${option.phaseKind}`,
        name: "Registry rail service",
        description: "Settles through a registry rail.",
        rails: [option.railId],
        delivery: ["deliver-storage-program"],
        pricing: { kind: "fixed", amount: "0.01", currency: option.phaseKind === "pay-dem" ? "DEM" : "USD" },
      };
      const identity = await (await POST(request(base))).json() as { identityMessage: string; identityPresentedAt: number };
      const response = await POST(request({
        ...base,
        identityPresentedAt: identity.identityPresentedAt,
        identitySignature: Buffer.from(ed25519Sign(Buffer.from(identity.identityMessage, "utf8"), privateKey)).toString("hex"),
      }));
      assert.equal(response.status, 200, option.railId);
      const preview = await response.json() as {
        listing: { pipeline: Array<{ kind: string; parameters?: Record<string, unknown> }>; acceptedRails: Array<{ railId: string }> };
        railResolution: { disposition: string; authorityBasis: string };
      };
      assert.deepEqual(preview.listing.acceptedRails, [{ railId: option.railId }]);
      assert.deepEqual(preview.listing.pipeline.find((phase) => phase.kind === option.phaseKind)?.parameters, { rail: option.railId });
      assert.equal(preview.railResolution.authorityBasis, "pa1-in-code");
      const independent = resolveAgainstStandard(preview.listing);
      assert.equal(independent.disposition, "verified", `${option.railId}: ${independent.reason}`);
      // The handler name the Directory used to emit as a rail ID is not in the registry.
      const handlerAsRail = resolveAgainstStandard({
        pipeline: [{ kind: option.phaseKind, parameters: { rail: option.phaseKind } }],
        acceptedRails: [{ railId: option.phaseKind }],
      });
      assert.equal(handlerAsRail.disposition, "rejected", option.phaseKind);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("the catalog projection keeps every registry rail ID for the §6.3.6 rail filter", () => {
  const presentation = listingPresentation({
    offering: { title: "Rails", description: "", category: "services.other" },
    pipeline: [],
    acceptedRails: registry.rails.map((rail) => ({ railId: rail.railId })),
  });
  assert.deepEqual(presentation.rails, registry.rails.map((rail) => rail.railId));
});
