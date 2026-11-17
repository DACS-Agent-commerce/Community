import assert from "node:assert/strict";
import test from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { signedScope } from "../src/catalog/evidenceGraph.js";
import { deriveIdentityTier, type RecipePolicy } from "../src/catalog/identityVerification.js";
import { type Obj, dids, locator, maps, ref, sign, vector, graphAt } from "./fixtures/current-evidence.js";

type Fixture = Awaited<ReturnType<typeof vector>>;

const REFERENCE_REJECTION = "duplicate or invalid top-level reference";
const PARTY_REJECTION = "invalid or duplicate bundle parties";
const PARTY_HASH = "a".repeat(64);

const respellings: Array<[name: string, spell: (hash: string) => string]> = [
  ["uppercase hex", (hash) => hash.toUpperCase()],
  ["sha256- prefix", (hash) => `sha256-${hash}`],
  ["sha256: prefix", (hash) => `sha256:${hash}`],
  ["uppercase SHA256- prefix", (hash) => `SHA256-${hash}`],
  ["uppercase SHA256: prefix with uppercase hex", (hash) => `SHA256:${hash.toUpperCase()}`],
];

/** Signs the buyer bundle again after `mutate` changed its scope, so only the changed field is under test. */
async function installBundle(fixture: Fixture, mutate: (scope: Obj) => void) {
  const scope = structuredClone(signedScope(fixture.buyerBundle, "bundle"));
  mutate(scope);
  const signatures = [await sign(scope, "bundle", 0, true), await sign(scope, "bundle", 1, true)];
  maps.set(fixture.locators.buyer, { ...scope, signatures, anchoredByRole: "buyer" });
  return graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
}

const parties = (scope: Obj) => scope.parties as Obj[];
const agreementRefOf = (scope: Obj) => scope.agreementRef as Obj;

test("a bundle with bare lowercase hashes is accepted", async () => {
  const fixture = await vector();
  const graph = await installBundle(fixture, () => undefined);
  assert.equal(graph.ok, true, graph.reason);
});

test("a party bundleHash in the lowercase sha256: spelling is accepted", async () => {
  const fixture = await vector();
  const graph = await installBundle(fixture, (scope) => { parties(scope)[0].bundleHash = `sha256:${PARTY_HASH}`; });
  assert.equal(graph.ok, true, graph.reason);
});

// The lowercase sha256: prefix is the one historical party spelling the SDK still accepts (tested above).
for (const [name, spell] of respellings.filter(([name]) => name !== "sha256: prefix")) {
  test(`a bundle party bundleHash with ${name} is rejected`, async () => {
    const fixture = await vector();
    const graph = await installBundle(fixture, (scope) => { parties(scope)[0].bundleHash = spell(PARTY_HASH); });
    assert.equal(graph.ok, false);
    assert.equal(graph.reason, PARTY_REJECTION);
  });
}

for (const [name, spell] of respellings) {
  test(`an agreementRef contentHash with ${name} is rejected`, async () => {
    const fixture = await vector();
    const graph = await installBundle(fixture, (scope) => {
      agreementRefOf(scope).contentHash = spell(agreementRefOf(scope).contentHash as string);
    });
    assert.equal(graph.ok, false);
    assert.equal(graph.reason, REFERENCE_REJECTION);
  });
}

for (const [name, spell] of respellings) {
  test(`a settlement evidence contentHash with ${name} is rejected`, async () => {
    const fixture = await vector();
    const graph = await installBundle(fixture, (scope) => {
      const evidenceRef = (scope.settlementEvidence as Obj[])[0];
      evidenceRef.contentHash = spell(evidenceRef.contentHash as string);
    });
    assert.equal(graph.ok, false);
    assert.equal(graph.reason, REFERENCE_REJECTION);
  });
}

for (const [name, spell] of respellings) {
  test(`a bundle listingRef contentHash with ${name} is rejected`, async () => {
    const fixture = await vector();
    const graph = await installBundle(fixture, (scope) => {
      const listingRef = scope.listingRef as Obj;
      listingRef.contentHash = spell(listingRef.contentHash as string);
    });
    assert.equal(graph.ok, false);
    assert.equal(graph.reason, "listing reference failed");
  });
}

const identityPolicy: RecipePolicy = {
  scheme: "lei", recipeVersion: 2, methods: ["consensus-backed-proxy"], defaultMaxAgeSec: 60,
  availability: "live", trustedResultSigners: [dids[0]],
};

/** An identity claim whose VerifyResult and its authority evidence are signed and hash-bound by the references. */
async function identityWith(spell: (hash: string) => string, which: "verifiedBy" | "attestation") {
  maps.clear();
  const attested = { authority: "ok" };
  maps.set(locator(8), attested);
  const resultScope: Obj = { resultVersion: "1", scheme: "lei", identifier: "123", recipeVersion: 2, method: "consensus-backed-proxy",
    decision: "pass", reason: "found", fetchedAt: 10, verifiedAt: 20, validUntil: 200,
    attestation: { anchor: { kind: "storage-program", locator: locator(8) }, contentHash: which === "attestation" ? spell(contentHash(attested)) : contentHash(attested) } };
  const result: Obj = { ...resultScope, signature: await sign(resultScope, "verify-result", 0) };
  maps.set(locator(9), result);
  const verifiedBy = ref(locator(9), result, "verify-result", { recipeVersion: 2 });
  if (which === "verifiedBy") verifiedBy.contentHash = spell(verifiedBy.contentHash);
  return { claims: [{ ref: "lei:123", verifiedBy }] };
}

const tierOf = (identity: Obj) => deriveIdentityTier(identity, async () => identityPolicy, 100, async (at) => maps.get(at) ?? null);

test("identity tier accepts bare lowercase hashes on the VerifyResult and its authority evidence", async () => {
  assert.equal(await tierOf(await identityWith((hash) => hash, "verifiedBy")), "institutional");
});

for (const [name, spell] of respellings) {
  test(`identity tier rejects a verifiedBy contentHash with ${name}`, async () => {
    assert.equal(await tierOf(await identityWith(spell, "verifiedBy")), "self-declared");
  });
  test(`identity tier rejects an authority evidence contentHash with ${name}`, async () => {
    assert.equal(await tierOf(await identityWith(spell, "attestation")), "self-declared");
  });
}
