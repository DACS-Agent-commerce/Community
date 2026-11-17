import assert from "node:assert/strict";
import test from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { signedScope } from "../src/catalog/evidenceGraph.js";
import { type Obj, vector, maps, graphAt, installAgreement } from "./fixtures/current-evidence.js";

type Fixture = Awaited<ReturnType<typeof vector>>;

const graphOf = (fixture: Fixture) => graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
const MAX_ARTIFACT_JSON_BYTES = 65_536;

test("an agreement the store cannot read fails with the read-failed cause", async () => {
  const fixture = await vector();
  maps.delete(fixture.locators.agreement);
  const graph = await graphOf(fixture);
  assert.equal(graph.ok, false);
  assert.equal(graph.reason, "agreement reference failed: read-failed");
});

test("an agreement with a malformed field fails with the shape cause", async () => {
  const fixture = await vector();
  const scope = structuredClone(signedScope(fixture.agreement, "agreement"));
  scope.generatedAt = "not-a-time";
  await installAgreement(fixture, scope);
  const graph = await graphOf(fixture);
  assert.equal(graph.reason, "agreement reference failed: shape");
});

test("an agreement changed after the bundle pinned it fails with the hash-mismatch cause", async () => {
  const fixture = await vector();
  const changedTerms = { ...(fixture.agreement.terms as Obj), deadline: 2000 };
  maps.set(fixture.locators.agreement, { ...fixture.agreement, terms: changedTerms });
  const graph = await graphOf(fixture);
  assert.equal(graph.reason, "agreement reference failed: hash-mismatch");
});

test("an agreement without its required signatures fails with the signature cause", async () => {
  const fixture = await vector();
  maps.set(fixture.locators.agreement, { ...fixture.agreement, signatures: [] });
  const graph = await graphOf(fixture);
  assert.equal(graph.reason, "agreement reference failed: signature");
});

test("an agreement over the artifact size limit fails with the too-large cause", async () => {
  const fixture = await vector();
  maps.set(fixture.locators.agreement, { ...fixture.agreement, padding: "x".repeat(MAX_ARTIFACT_JSON_BYTES) });
  const graph = await graphOf(fixture);
  assert.equal(graph.reason, "agreement reference failed: too-large");
});

test("a settlement evidence artifact the store cannot read names its kind and cause", async () => {
  const fixture = await vector();
  maps.delete(fixture.locators.evidence);
  const graph = await graphOf(fixture);
  assert.equal(graph.reason, "evidence reference failed: read-failed");
});

test("a rating changed after the bundle pinned it names its kind and the hash-mismatch cause", async () => {
  const fixture = await vector();
  maps.set(fixture.locators.rating, { ...fixture.rating, value: 1 });
  const graph = await graphOf(fixture);
  assert.equal(graph.reason, "rating reference failed: hash-mismatch");
});
