import assert from "node:assert/strict";
import test from "node:test";
import "./fixtures/isolated-data-dir.js";
import { buildCurrentEvidenceGraph, signedScope, type ArtifactKind, type EvidenceGraph } from "../src/catalog/evidenceGraph.js";
import { dids, locator, maps, ref, sign, vector, type Obj } from "./fixtures/current-evidence.js";
import { fixtureCommitments } from "./fixtures/commitment-proof.js";

type Route = { name: string; kind: ArtifactKind; reason: string; parent?: string };
type Failure = "valid" | "read-null" | "read-throw" | "too-large" | "shape" | "hash-mismatch" | "signature" | "bad-ref";
const direct: Route[] = ["agreement", "evidence", "composite", "rating"].map((kind) => ({
  name: kind, kind: kind as ArtifactKind, reason: `${kind} reference failed`,
}));
const nested: Route[] = [
  { name: "freshness", kind: "verify-result", reason: "nested VerifyResult reference failed", parent: "composite" },
  { name: "dealSpecific", kind: "verify-result", reason: "nested VerifyResult reference failed", parent: "composite" },
  { name: "supplementary", kind: "attestation", reason: "supplementary attestation reference failed", parent: "composite" },
  { name: "attestationRef", kind: "attestation", reason: "delivery attestation reference failed", parent: "evidence" },
  { name: "amendmentRefs", kind: "evidence", reason: "settlement amendment reference failed", parent: "evidence" },
  { name: "supersedesEvidenceRef", kind: "evidence", reason: "settlement evidence chain failed", parent: "evidence" },
  { name: "amendsEvidenceRef", kind: "evidence", reason: "settlement evidence chain failed", parent: "evidence" },
  { name: "attestation", kind: "attestation", reason: "VerifyResult attestation reference failed", parent: "verify-result" },
];
const compositeScope = (): Obj => ({ recordVersion: "1", jobId: "job-1", evaluatedParty: dids[1],
  overallDecision: "pass", freshness: [], dealSpecific: [], supplementary: [] });
const resultScope = (attestation: unknown): Obj => ({ resultVersion: "1", scheme: "lei", identifier: "123",
  decision: "pass", verifiedAt: 20, attestation });
const component = async (scope: Obj, kind: "evidence" | "composite" | "verify-result") =>
  ({ ...scope, signature: await sign(scope, kind, 1) });

async function graphFor(route: Route, failure: Failure) {
  const f = await vector();
  const target = locator(20);
  const authority = { authority: "registry", status: "active" };
  maps.set(locator(21), authority);
  let child: Obj = route.kind === "agreement" ? f.agreement
    : route.kind === "rating" ? f.rating
    : route.kind === "evidence" ? await component({ ...signedScope(f.evidence, "evidence"), observedAt: 101 }, "evidence")
    : route.kind === "composite" ? await component(compositeScope(), "composite")
    : route.kind === "verify-result" ? await component(resultScope(ref(locator(21), authority, "attestation")), "verify-result")
    : authority;
  const reference = failure === "bad-ref" ? {} : ref(target, child, route.kind);
  if (failure === "too-large") child = { ...child, padding: "x".repeat(65_536) };
  if (failure === "shape") {
    const version = { agreement: "agreementVersion", evidence: "evidenceVersion", composite: "recordVersion", rating: "ratingVersion",
      "verify-result": "resultVersion" };
    child = { ...child, [version[route.kind as keyof typeof version]]: null };
  }
  if (failure === "hash-mismatch") child = { ...child, changed: true };
  if (failure === "signature") child = route.kind === "agreement" ? { ...child, signatures: [] }
    : { ...child, signature: { ...(child.signature as Obj), value: "invalid" } };
  maps.set(target, child);
  if (failure === "read-null") maps.delete(target);

  const bundle = signedScope(f.buyerBundle, "bundle");
  const installComposite = async (scope: Obj) => {
    const parent = await component(scope, "composite");
    maps.set(locator(22), parent);
    bundle.vetRecords = [ref(locator(22), parent, "composite")];
  };
  if (!route.parent) {
    const key = { agreement: "agreementRef", evidence: "settlementEvidence", composite: "vetRecords", rating: "ratingRefs" };
    bundle[key[route.kind as keyof typeof key]] = route.kind === "agreement" ? reference : [reference];
  } else if (route.parent === "composite") {
    const scope = compositeScope();
    scope[route.name] = route.name === "supplementary"
      ? [{ source: "external", signalType: "test", value: 1, observedAt: 20, attestation: reference }] : [reference];
    await installComposite(scope);
  } else if (route.parent === "verify-result") {
    const parent = await component(resultScope(reference), "verify-result");
    maps.set(locator(23), parent);
    await installComposite({ ...compositeScope(), freshness: [ref(locator(23), parent, "verify-result")] });
  } else {
    const scope = signedScope(f.evidence, "evidence");
    scope[route.name] = route.name === "amendmentRefs" ? [reference] : reference;
    const parent = await component(scope, "evidence");
    maps.set(f.locators.evidence, parent);
    bundle.settlementEvidence = [ref(f.locators.evidence, parent, "evidence")];
  }
  maps.set(f.locators.buyer, { ...bundle, signatures: [await sign(bundle, "bundle", 0, true),
    await sign(bundle, "bundle", 1, true)], anchoredByRole: "buyer" });
  return buildCurrentEvidenceGraph(f.locators.buyer, {
    commitment: fixtureCommitments,
    read: async (at) => {
      if (at === target && failure === "read-throw") throw new Error("raw upstream detail /internal/path");
      return maps.get(at) ?? null;
    },
    resolveListing: async () => ({ locator: f.locators.listing, raw: f.listing }),
  });
}

function assertRefused(graph: EvidenceGraph) {
  assert.equal(graph.ok, false);
  assert.equal(graph.refsVerified, false);
  assert.equal(graph.credit, undefined);
  assert.equal(graph.bundleContentHash, "");
  assert.deepEqual(graph.artifacts, []);
  assert.deepEqual(graph.ratings, []);
}

test("valid control: every direct and nested reference route still authenticates and verifies", async () => {
  for (const route of [...direct, ...nested]) {
    const graph = await graphFor(route, "valid");
    assert.equal(graph.ok, true, `${route.name}: ${graph.reason}`);
    assert.equal(graph.signaturesVerified, true, route.name);
    assert.equal(graph.refsVerified, true, `${route.name}: ${graph.reason}`);
  }
});

test("refusal control: every observable failure still refuses admission", async () => {
  for (const failure of ["read-null", "read-throw", "too-large", "shape", "hash-mismatch", "signature"] as const) {
    assertRefused(await graphFor(direct[0], failure));
  }
  assertRefused(await graphFor(nested[4], "bad-ref"));
});

for (const route of direct) for (const failure of ["read-null", "read-throw", "too-large", "shape", "hash-mismatch", "signature"] as const) {
  test(`diagnostic: ${route.name} reports ${failure}`, async () => {
    const graph = await graphFor(route, failure);
    assertRefused(graph);
    assert.equal(graph.reason, `${route.reason}: ${failure.startsWith("read-") ? "read-failed" : failure}`);
    assert.equal(graph.errorCause, undefined, "raw read errors are not exposed");
  });
}

for (const route of nested) for (const failure of ["read-null", "read-throw", "hash-mismatch", "too-large"] as const) {
  test(`diagnostic: nested ${route.name} reports ${failure}`, async () => {
    const graph = await graphFor(route, failure);
    assertRefused(graph);
    assert.equal(graph.reason, `${route.reason}: ${failure.startsWith("read-") ? "read-failed" : failure}`);
    assert.equal(graph.errorCause, undefined, "raw read errors are not exposed");
  });
}

// Attestations have no shape or signature check, so only signed nested kinds carry these causes.
for (const route of nested.filter((candidate) => candidate.kind !== "attestation")) {
  for (const failure of ["shape", "signature"] as const) {
    test(`diagnostic: nested ${route.name} reports ${failure}`, async () => {
      const graph = await graphFor(route, failure);
      assertRefused(graph);
      assert.equal(graph.reason, `${route.reason}: ${failure}`);
    });
  }
}

// A malformed attestation reference is refused earlier by its parent's shape check, so bad-ref is
// observable only on routes whose parent shape accepts any value there.
for (const route of nested.filter((candidate) => candidate.kind !== "attestation" && candidate !== nested[4])) {
  test(`diagnostic: nested ${route.name} reports bad-ref`, async () => {
    const graph = await graphFor(route, "bad-ref");
    assertRefused(graph);
    assert.equal(graph.reason, `${route.reason}: bad-ref`);
  });
}

test("diagnostic: malformed nested reference reports bad-ref without reading it", async () => {
  const graph = await graphFor(nested[4], "bad-ref");
  assertRefused(graph);
  assert.equal(graph.reason, "settlement amendment reference failed: bad-ref");
});
