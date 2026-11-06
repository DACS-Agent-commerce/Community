import assert from "node:assert/strict";
import test from "node:test";
// First: the store must open in a fresh directory, never the checkout's data/.
import "./fixtures/isolated-data-dir.js";
import { signedScope, verifiedDiscoveryAgreement } from "../src/catalog/evidenceGraph.js";
import { type Obj, vector, payeeBoundVector, installAgreement, graphAt } from "./fixtures/current-evidence.js";
import { deliverableRefFor } from "./fixtures/agreement-fields.js";

// DACS-3 §8.5.2 item 4: `terms.deliverable` is a required DeliverableRef (DACS-4 §9.3) whose deliverableType,
// hash and schemaUrl must equal those derived from the listing's `offering.deliverable`. A missing or mistyped
// value is a malformed agreement; a well-formed value that differs does not match its listing.
const PROFILES = [["legacy", vector], ["payee-bound", payeeBoundVector]] as const;
const MALFORMED_REFUSAL = "agreement reference failed";
const LISTING_MISMATCH_REFUSAL = "agreement artifact does not match the pinned listing pipeline";
const ABSENT = Symbol("absent");
const SCHEMA_URL = "https://example.test/schema/v1";
const OTHER_SCHEMA_URL = "https://example.test/schema/v2";
const OTHER_HASH = "d".repeat(64);

type Mutation = [name: string, apply: (terms: Obj) => void];

const setOrDelete = (target: Obj, key: string, value: unknown) => {
  if (value === ABSENT) delete target[key]; else target[key] = value;
};
const deliverableOf = (terms: Obj) => terms.deliverable as Obj;

async function graphWithDeliverable(make: typeof vector, mutate: (terms: Obj) => void) {
  const fixture = await make();
  const scope = structuredClone(signedScope(fixture.agreement, "agreement"));
  mutate(scope.terms as Obj);
  await installAgreement(fixture, scope);
  return { agreement: fixture.agreement, graph: await graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing) };
}

async function assertMalformed(profile: string, name: string, make: typeof vector, mutate: (terms: Obj) => void) {
  const { agreement, graph } = await graphWithDeliverable(make, mutate);
  assert.equal(graph.ok, false, `${profile}: ${name}`);
  assert.equal(graph.reason, MALFORMED_REFUSAL, `${profile}: ${name}`);
  assert.equal(await verifiedDiscoveryAgreement(agreement), false, `${profile}: ${name}: discovery`);
}

async function assertNotMatchingListing(profile: string, name: string, make: typeof vector, mutate: (terms: Obj) => void) {
  const { graph } = await graphWithDeliverable(make, mutate);
  assert.equal(graph.ok, false, `${profile}: ${name}`);
  assert.equal(graph.reason, LISTING_MISMATCH_REFUSAL, `${profile}: ${name}`);
}

async function assertAccepted(profile: string, name: string, make: typeof vector, mutate: (terms: Obj) => void) {
  const { agreement, graph } = await graphWithDeliverable(make, mutate);
  assert.equal(graph.ok, true, `${profile}: ${name}: ${graph.reason}`);
  assert.equal(await verifiedDiscoveryAgreement(agreement), true, `${profile}: ${name}: discovery`);
}

const withDeliverable = (value: unknown): Mutation[1] => (terms) => setOrDelete(terms, "deliverable", value);
const withMember = (key: string, value: unknown): Mutation[1] => (terms) => setOrDelete(deliverableOf(terms), key, value);

const malformedDeliverables: Mutation[] = [
  ["terms.deliverable absent", withDeliverable(ABSENT)],
  ["terms.deliverable null", withDeliverable(null)],
  ["terms.deliverable a string", withDeliverable("attested-payload")],
  ["terms.deliverable a number", withDeliverable(7)],
  ["terms.deliverable an array", withDeliverable([])],
  ["terms.deliverable the listing's DeliverableSpec instead of a reference", withDeliverable({ kind: "attested-payload", payloadFormat: "application/json" })],
  ["deliverableType absent", withMember("deliverableType", ABSENT)],
  ["deliverableType not a string", withMember("deliverableType", 7)],
  ["deliverableType array-wrapped", withMember("deliverableType", ["attested-payload"])],
  ["hash absent", withMember("hash", ABSENT)],
  ["hash not a string", withMember("hash", 7)],
  ["hash too short", withMember("hash", "a".repeat(63))],
  ["hash not hex", withMember("hash", "g".repeat(64))],
  ["hash uppercase", withMember("hash", "A".repeat(64))],
  ["hash with a sha256: prefix", withMember("hash", `sha256:${OTHER_HASH}`)],
  ["schemaUrl not a string", withMember("schemaUrl", 7)],
  ["schemaUrl null", withMember("schemaUrl", null)],
];

test("agreements whose terms.deliverable is missing or mistyped are refused as malformed for each profile", async () => {
  for (const [profile, make] of PROFILES) {
    for (const [name, apply] of malformedDeliverables) await assertMalformed(profile, name, make, apply);
  }
});

test("an agreement whose deliverable equals the listing's is accepted for each profile", async () => {
  for (const [profile, make] of PROFILES) await assertAccepted(profile, "equal deliverable", make, () => undefined);
});

const differingDeliverables: Mutation[] = [
  ["deliverableType differs", withMember("deliverableType", "external")],
  ["hash differs", withMember("hash", OTHER_HASH)],
  ["schemaUrl present on the agreement only", withMember("schemaUrl", SCHEMA_URL)],
];

test("an agreement whose deliverable differs from the listing's is refused as not matching it for each profile", async () => {
  for (const [profile, make] of PROFILES) {
    for (const [name, apply] of differingDeliverables) await assertNotMatchingListing(profile, name, make, apply);
  }
});

const listingDeliverable = (extra: Obj = {}): Obj =>
  ({ kind: "attested-payload", payloadFormat: "application/json", verificationMethod: { kind: "self-signed" }, ...extra });

async function graphWithListingDeliverable(spec: Obj, agreedRef: Obj) {
  const fixture = await vector("job-1", 0, undefined, spec);
  const scope = structuredClone(signedScope(fixture.agreement, "agreement"));
  (scope.terms as Obj).deliverable = agreedRef;
  await installAgreement(fixture, scope);
  return graphAt(fixture.locators.buyer, fixture.listing, fixture.locators.listing);
}

test("a listing deliverable carrying a schemaUrl is matched by an agreement that carries the same schemaUrl", async () => {
  const spec = listingDeliverable({ schemaUrl: SCHEMA_URL });
  const graph = await graphWithListingDeliverable(spec, deliverableRefFor(spec));
  assert.equal(graph.ok, true, graph.reason);
});

test("an agreement that drops the listing's schemaUrl is refused as not matching it", async () => {
  const spec = listingDeliverable({ schemaUrl: SCHEMA_URL });
  const { schemaUrl, ...withoutSchemaUrl } = deliverableRefFor(spec);
  assert.equal(schemaUrl, SCHEMA_URL);
  const graph = await graphWithListingDeliverable(spec, withoutSchemaUrl);
  assert.equal(graph.ok, false);
  assert.equal(graph.reason, LISTING_MISMATCH_REFUSAL);
});

test("an agreement that changes the listing's schemaUrl is refused as not matching it", async () => {
  const spec = listingDeliverable({ schemaUrl: SCHEMA_URL });
  const graph = await graphWithListingDeliverable(spec, { ...deliverableRefFor(spec), schemaUrl: OTHER_SCHEMA_URL });
  assert.equal(graph.ok, false);
  assert.equal(graph.reason, LISTING_MISMATCH_REFUSAL);
});

test("the deliverable hash covers every member of the anchored spec, including members named signature", async () => {
  const spec = listingDeliverable({ signature: "carried as ordinary data" });
  const accepted = await graphWithListingDeliverable(spec, deliverableRefFor(spec));
  assert.equal(accepted.ok, true, accepted.reason);
  const withoutMember = deliverableRefFor(listingDeliverable());
  const refused = await graphWithListingDeliverable(spec, withoutMember);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, LISTING_MISMATCH_REFUSAL);
});
