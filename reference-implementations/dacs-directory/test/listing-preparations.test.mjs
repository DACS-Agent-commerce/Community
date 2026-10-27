import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { NextRequest } from "next/server.js";
import { contentHash } from "./fixtures/listing-preparation-boundaries.mjs";

const app = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "listing-preparations-"));
const bundleDirectory = mkdtempSync(join(app, "node_modules", ".listing-preparations-"));
const bundle = join(bundleDirectory, "index.mjs");
process.env.DACS_DIRECTORY_DATA = directory;
const boundaries = resolve(app, "test/fixtures/listing-preparation-boundaries.mjs");
// Keep the cross-producer regression runnable on revisions predating the resolver module.
await build({
  stdin: { contents: `export * from './src/catalog/buildListing.ts'; export * from './src/catalog/store.ts';
    ${existsSync(new URL("../src/catalog/listingVersionOccupancy.ts", import.meta.url)) ? "export * from './src/catalog/listingVersionOccupancy.ts';" : ""}
    export { pinnedChainIdentity } from './src/catalog/nodeDeployment.ts';
    export { POST as routePost } from './app/api/dacs/build-listing/route.ts';
    export { nodeDeployment } from './test/fixtures/listing-preparation-boundaries.mjs';`, resolveDir: app },
  outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [publicationBoundaries()],
});
function publicationBoundaries() {
  return { name: "publication-boundaries", setup(builder) {
    builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server.js", external: true }));
    builder.onResolve({ filter: /^@kynesyslabs\/dacs\// }, () => ({ path: boundaries }));
    builder.onResolve({ filter: /\/(sdkListingValidation|listingVerification|listingFinality|registrationSig|wellknown)(\.js)?$/ },
      () => ({ path: boundaries }));
    builder.onResolve({ filter: /^\.\/(wellknown|listingVerification)\.js$/ }, () => ({ path: boundaries }));
  } };
}
const module = await import(pathToFileURL(bundle).href);
const rails = [{ railId: "ap2:stripe-paymentintents", railVersion: 1, phaseHandler: "pay-ap2", governanceAnchoring: "in-code", signatureValid: true }];
const qualifiedEmpty = async (logicalAddress, chainIdentity) => ({ status: "complete", logicalAddress, chainIdentity, nativeAddresses: [] });
const post = module.createBuildListingPost(rails);
const clock = 1_800_000_000_000;
const key = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 12)]),
  format: "der", type: "pkcs8",
});
const ownerHex = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const inputFor = (id) => ({
  claim: `did:demos:agent:${ownerHex}`, serviceId: id, name: "Listing preparation test",
  description: "A bounded deterministic fixture.", rails: ["ap2:stripe-paymentintents"], delivery: ["deliver-storage-program"],
  pricing: { kind: "fixed", amount: "1", currency: "USD" },
});
const request = (body) => new NextRequest("https://directory.example/api/dacs/build-listing", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const walletSign = (message) => sign(null, Buffer.from(message), key).toString("hex");
const db = new Database(join(directory, "directory.sqlite"));
test.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); rmSync(bundleDirectory, { recursive: true, force: true }); });

function node(t) {
  const state = { nonce: 0, nonceReads: 0, published: null, lookup: "empty" };
  t.mock.method(Date, "now", () => clock);
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (init?.method === "POST") {
      const call = JSON.parse(String(init.body)).params[0];
      if (call.message === "getAddressNonce") {
        state.nonceReads++;
        return Response.json({ result: 200, response: state.nonce++ });
      }
      assert.equal(call.message, "searchStoragePrograms");
      if (state.lookup === "failed") return new Response("unavailable", { status: 503 });
      if (state.lookup === "oversized") return Response.json({ result: 200, response: [], padding: "x".repeat(1024 * 1024) });
      const found = state.published && call.data.query === state.published.programName;
      const rows = found ? [{ storageAddress: state.published.anchorAddress, programName: state.published.programName }] : [];
      return Response.json({ result: 200, response: state.lookup === "ambiguous" ? [...rows, ...rows] : rows });
    }
    assert.ok(state.published && String(url).endsWith(state.published.anchorAddress));
    return Response.json({ success: true, data: state.published.listing, owner: `0x${ownerHex}`, programName: state.published.programName,
      metadata: { logicalAddress: state.published.logicalAddress }, ...state.published.storageOverrides });
  });
  return state;
}
async function signedInput(id, overrides = {}) {
  const input = { ...inputFor(id), ...overrides };
  const identityResponse = await post(request(input));
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json();
  const authenticated = { ...input, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: walletSign(identity.identityMessage) };
  const previewResponse = await post(request(authenticated));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.tx, null);
  return { ...authenticated, listingSignature: walletSign(preview.message) };
}
async function prepare(input) {
  const response = await post(request(input));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.tx);
  return body;
}
async function unresolved(response, anchor) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /preparation.*unresolved/i);
  assert.equal(body.anchorAddress, anchor);
  assert.equal(body.tx, undefined);
}
async function resumed(response, first) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.anchorAddress, first.anchorAddress, "the same signed Listing must never receive a different anchor");
  assert.equal(JSON.stringify(body.tx), JSON.stringify(first.tx), "the exact saved transaction bytes, never a rebuilt one");
}

test("an exact signed repeat after empty lookups and advancing nonces gets the saved transaction, never a second anchor", async (t) => {
  const state = node(t);
  const signed = await signedInput("advancing-nonce");
  const first = await prepare(signed);
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1, "a repeat never asks for a replacement nonce");
});

test("a freshly signed different candidate cannot replace the prepared logical version", async (t) => {
  node(t);
  const original = await signedInput("changed-candidate");
  const first = await prepare(original);
  t.mock.method(Date, "now", () => clock + 60_000);
  const changed = await signedInput("changed-candidate", { description: "Different signed contents" });
  await unresolved(await post(request(changed)), first.anchorAddress);
});

test("previews, invalid Listing signatures and the shipped route do not reserve a version", async (t) => {
  node(t);
  const signed = await signedInput("unauthenticated");
  const refused = await post(request({ ...signed, listingSignature: "00".repeat(64) }));
  assert.equal(refused.status, 400);
  const shipped = await module.routePost(request(inputFor("unauthenticated")));
  assert.equal(shipped.status, 409, "unsigned shipped rail authority still refuses publication");
  await prepare(signed);
});

test("a lost response is released again by a fresh process with the exact saved transaction bytes", async (t) => {
  node(t);
  const signed = await signedInput("restart");
  const first = await prepare(signed);
  const row = db.prepare("SELECT anchor_address, transaction_json FROM listing_preparations WHERE logical_address=?").get(first.logicalAddress);
  assert.equal(row.anchor_address, first.anchorAddress);
  assert.equal(row.transaction_json, JSON.stringify(first.tx));
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { NextRequest } from ${JSON.stringify(pathToFileURL(resolve(app, "node_modules/next/server.js")).href)};
    const { createBuildListingPost } = await import(${JSON.stringify(pathToFileURL(bundle).href)});
    Date.now = () => ${clock};
    globalThis.fetch = async (_url, init) => {
      const call = JSON.parse(init.body).params[0];
      if (call.message === 'getAddressNonce') throw new Error('restart must not request a nonce');
      return Response.json({result:200,response:[]});
    };
    const response = await createBuildListingPost(${JSON.stringify(rails)})(new NextRequest('https://directory.example/api/dacs/build-listing',
      {method:'POST',headers:{'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(signed))}}));
    process.stdout.write(JSON.stringify({status:response.status,body:await response.json()}));
  `], { encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.stderr);
  const retried = JSON.parse(child.stdout);
  assert.equal(retried.status, 200);
  assert.equal(retried.body.anchorAddress, first.anchorAddress);
  assert.equal(JSON.stringify(retried.body.tx), row.transaction_json);
  assert.equal(db.prepare("SELECT transaction_json FROM listing_preparations WHERE logical_address=?").get(first.logicalAddress).transaction_json, row.transaction_json);
});

test("an expired signed presentation gets its saved transaction again and cannot authorize a fresh create", async (t) => {
  node(t);
  const signed = await signedInput("expired-pending");
  const unprepared = await signedInput("expired-new");
  const first = await prepare(signed);
  t.mock.method(Date, "now", () => clock + 16 * 60_000);
  await resumed(await post(request(signed)), first);
  const response = await post(request(unprepared));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /identity presentation expired/);
});

const pinned = module.nodeDeployment.current;
const offPinNodes = [
  ["an unpinned build", { ok: false, reason: "Demos node build fixture+dirty is not pinned" }, 409, /fixture\+dirty is not pinned; no transaction was prepared/],
  ["another chain", { ok: false, reason: "Demos node serves chain other-chain, not the pinned chain" }, 409, /other-chain, not the pinned chain; no transaction was prepared/],
  ["an unreadable node", new Error("getNetworkInfo transport failed"), 503, /could not read the Demos node's build and chain \(getNetworkInfo transport failed\)/],
];
async function refusedOffPin(t, signed) {
  t.after(() => { module.nodeDeployment.current = pinned; });
  for (const [name, deployment, status, cause] of offPinNodes) {
    module.nodeDeployment.current = deployment;
    const response = await post(request(signed));
    assert.equal(response.status, status, name);
    const body = await response.json();
    assert.match(body.error, cause, name);
    assert.equal(body.tx, undefined, name);
  }
  module.nodeDeployment.current = pinned;
}

test("an exact signed repeat gets no saved transaction while the node is off the pin", async (t) => {
  const state = node(t);
  const signed = await signedInput("repeat-off-pin");
  const first = await prepare(signed);
  await refusedOffPin(t, signed);
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1);
});

test("an expired signed repeat gets no saved transaction while the node is off the pin", async (t) => {
  const state = node(t);
  const signed = await signedInput("expired-repeat-off-pin");
  const first = await prepare(signed);
  t.mock.method(Date, "now", () => clock + 16 * 60_000);
  await refusedOffPin(t, signed);
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1);
});

test("a retained preparation still validates the retried Listing signature", async (t) => {
  const state = node(t);
  const signed = await signedInput("invalid-retained-signature");
  const first = await prepare(signed);
  for (const listingSignature of ["malformed", "00".repeat(64)]) {
    const response = await post(request({ ...signed, listingSignature }));
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.tx, undefined);
    assert.equal(body.anchorAddress, undefined);
  }
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1);
});

test("an expired preview cannot resume a preparation without a Listing signature", async (t) => {
  const state = node(t);
  const signed = await signedInput("expired-retained-preview");
  await prepare(signed);
  t.mock.method(Date, "now", () => clock + 16 * 60_000);
  const response = await post(request({ ...signed, listingSignature: undefined }));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /identity presentation expired/);
  assert.equal(body.tx, undefined);
  assert.equal(body.anchorAddress, undefined);
  assert.equal(state.nonceReads, 1);
});

test("current authenticated readback resumes without a write and later missing reads cannot erase occupancy", async (t) => {
  const state = node(t);
  const signed = await signedInput("observed");
  const first = await prepare(signed);
  state.published = first;
  t.mock.method(Date, "now", () => clock + 16 * 60_000);
  const recovered = await post(request(signed));
  assert.equal(recovered.status, 200);
  const body = await recovered.json();
  assert.equal(body.exists, true);
  assert.equal(body.tx, null);
  assert.deepEqual(body.listing, first.listing);
  module.clearChainDerivedArtifacts();
  module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [] });
  state.published = null;
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1);
});

test("failed, oversized and ambiguous lookups retain the preparation and withhold a replacement", async (t) => {
  const state = node(t);
  const signed = await signedInput("uncertain");
  const first = await prepare(signed);
  for (const lookup of ["failed", "oversized", "ambiguous"]) {
    state.lookup = lookup;
    state.published = lookup === "ambiguous" ? first : null;
    const response = await post(request(signed));
    assert.equal(response.status, 503, lookup);
    assert.match((await response.json()).error, /could not safely determine/);
  }
  state.lookup = "empty";
  state.published = null;
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1);
});

test("a prepared version the catalog already lists returns its saved anchor and never a transaction", async (t) => {
  const state = node(t);
  const signed = await signedInput("catalog-listed");
  const unprepared = await signedInput("catalog-listed-unprepared");
  const first = await prepare(signed);
  const listed = (listingId) => ({ listingId, version: 1, anchor: { kind: "storage-program", locator: `stor-${"a".repeat(40)}` } });
  module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [{ primaryClaim: `did:demos:agent:${ownerHex}`,
    displayName: inputFor("catalog-listed").name, listings: [listed("catalog-listed"), listed("catalog-listed-unprepared")] }] });
  try {
    await unresolved(await post(request(signed)), first.anchorAddress);
    const resigned = await post(request({ ...signed, identityPresentedAt: clock - 1 }));
    assert.equal(resigned.status, 400, "a retry must still carry a valid identity signature before learning the anchor");
    const refused = await post(request(unprepared));
    assert.equal(refused.status, 409, "allowed control: a listed version this directory never prepared is refused");
    const body = await refused.json();
    assert.match(body.error, /already published this version/);
    assert.equal(body.anchorAddress, undefined);
    assert.equal(body.tx, undefined);
  } finally { module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [] }); }
  assert.equal(state.nonceReads, 1);
});

const catalogWithSeller = (displayName) => ({ catalogVersion: "1", generatedAt: clock,
  sellers: displayName ? [{ primaryClaim: `did:demos:agent:${ownerHex}`, displayName, listings: [] }] : [] });
for (const [change, before, after] of [
  ["gains", undefined, "Renamed seller"],
  ["renames", "Original seller", "Renamed seller"],
  ["drops", "Original seller", undefined],
]) {
  test(`an exact signed repeat gets its saved transaction after the catalog ${change} the seller's display name`, async (t) => {
    const state = node(t);
    module.saveCatalog(catalogWithSeller(before));
    try {
      const signed = await signedInput(`display-name-${change}`);
      const first = await prepare(signed);
      module.saveCatalog(catalogWithSeller(after));
      await resumed(await post(request(signed)), first);
    } finally { module.saveCatalog(catalogWithSeller(undefined)); }
    assert.equal(state.nonceReads, 1, "a repeat never asks for a replacement nonce");
  });
}

test("concurrent signed requests return at most one transaction and cannot overwrite its bytes", async (t) => {
  const state = node(t);
  const first = await signedInput("concurrent");
  const second = await signedInput("concurrent", { description: "Concurrent different artifact" });
  const responses = await Promise.all([post(request(first)), post(request(second))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  const winner = bodies.find((body) => body.tx);
  const row = db.prepare("SELECT transaction_json FROM listing_preparations WHERE logical_address=?").get(winner.logicalAddress);
  assert.equal(row.transaction_json, JSON.stringify(winner.tx));
  assert.equal(bodies.filter((body) => body.tx).length, 1);
  assert.equal(state.nonceReads, 2, "both requests passed the initial read before the atomic insert");
});

test("identical concurrent signed requests both receive only the winner's exact saved transaction", async (t) => {
  const state = node(t);
  const signed = await signedInput("concurrent-identical");
  const responses = await Promise.all([post(request(signed)), post(request(signed))]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  const row = db.prepare("SELECT anchor_address, transaction_json FROM listing_preparations WHERE logical_address=?").get(bodies[0].logicalAddress);
  for (const body of bodies) {
    assert.equal(body.anchorAddress, row.anchor_address);
    assert.equal(JSON.stringify(body.tx), row.transaction_json, "the losing request releases the winner's bytes, not its own");
  }
  assert.equal(state.nonceReads, 2, "both requests passed the initial read before the atomic insert");
});

test("a failed durable save releases no transaction and does not poison a later valid attempt", async (t) => {
  node(t);
  const signed = await signedInput("save-failure");
  db.exec("CREATE TRIGGER preparation_write_failure BEFORE INSERT ON listing_preparations BEGIN SELECT RAISE(ABORT, 'preparation disk failure'); END");
  try {
    await assert.rejects(post(request(signed)), /preparation disk failure/);
  } finally { db.exec("DROP TRIGGER preparation_write_failure"); }
  await prepare(signed);
});

test("preparation keys isolate logical versions, listing IDs and configured chains", async (t) => {
  node(t);
  const signed = await signedInput("independent");
  const first = await prepare(signed);
  const another = await signedInput("independent-other");
  await prepare(another);
  const preparation = { anchorAddress: first.anchorAddress, transactionJson: JSON.stringify(first.tx) };
  assert.equal(module.saveListingPreparation("fixture-other-chain", first.logicalAddress, preparation), true);
  assert.equal(module.saveListingPreparation("fixture-other-chain", `${first.logicalAddress}2`, preparation), true);
  assert.equal(module.saveListingPreparation("fixture-other-chain", first.logicalAddress,
    { ...preparation, transactionJson: "different" }), false);
  assert.equal(module.loadListingPreparation("fixture-other-chain", first.logicalAddress).transactionJson, preparation.transactionJson);
});

test("another producer's differently named Listing is recovered before catalog indexing", async (t) => {
  const state = node(t);
  const input = inputFor("other-producer");
  const identity = await (await post(request(input))).json();
  const authenticated = { ...input, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: walletSign(identity.identityMessage) };
  // An independent producer has already anchored the exact signed logical v1.
  // Nothing is registered or indexed locally, and neither name search can see it.
  const logicalAddress = `dacs1:${encodeURIComponent(input.claim)}:${input.serviceId}:v1`;
  const expected = { programName: "independent-publisher-release", anchorAddress: `stor-${"47".repeat(20)}` };
  let resolved = false;
  const resolveVersion = async (logical, chain, signal) => {
    resolved = true;
    assert.equal(logical, logicalAddress);
    assert.equal(chain, module.pinnedChainIdentity());
    assert.equal(signal.aborted, false);
    return { status: "complete", logicalAddress: logical, chainIdentity: chain, nativeAddresses: [expected.anchorAddress] };
  };
  const unsigned = { dacsVersion: "1", listingId: input.serviceId, listingVersion: 1,
    seller: { identity: { presentedBy: input.claim }, displayName: "Independent producer" } };
  const signature = { algorithm: "ed25519", signer: input.claim,
    value: Buffer.from(walletSign(`dacs-listing:v1:${contentHash(unsigned)}`), "hex").toString("base64url") };
  state.published = { ...expected, logicalAddress, listing: { ...unsigned, signature } };
  const [outcome] = await Promise.allSettled([module.createBuildListingPost(rails, resolveVersion)(request(authenticated))]);
  assert.equal(resolved, true, "empty producer-name lookups must consult logical-version occupancy");
  if (outcome.status === "rejected") throw outcome.reason;
  const response = outcome.value;
  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.exists, true);
  assert.equal(body.tx, null);
  assert.equal(body.programName, expected.programName);
  assert.deepEqual(body.listing, state.published.listing);
  assert.equal(state.nonceReads, 0);
});

test("empty producer-name searches permit a default preview and one signed create", async (t) => {
  const state = node(t);
  const signed = await signedInput("no-logical-resolver");
  const preview = await post(request({ ...signed, listingSignature: undefined }));
  assert.equal(preview.status, 200);
  const body = await preview.json();
  assert.equal(body.exists, false);
  assert.equal(body.listing.listingVersion, 1);
  assert.equal(body.tx, null);
  assert.equal(body.publicationReady, false);
  assert.equal(state.nonceReads, 0, "preview must not prepare a transaction");
  const first = await prepare(signed);
  assert.equal(first.exists, false);
  assert.equal(first.publicationReady, true);
  await resumed(await post(request(signed)), first);
  assert.equal(state.nonceReads, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM listing_preparations WHERE logical_address=?").get(first.logicalAddress).n, 1);
});

test("the default handler creates only the next version when a prior version is missing on chain", async (t) => {
  const state = node(t);
  const id = "default-next-version";
  const prior = await signedInput(id);
  const first = await prepare(prior);
  const catalog = module.loadCatalog();
  t.after(() => module.saveCatalog(catalog));
  module.saveCatalog({ ...catalog, sellers: [{
    primaryClaim: prior.claim, displayName: "Previously indexed seller", deals: [],
    listings: [{ listingId: id, version: 1, anchor: { kind: "storage-program", locator: first.anchorAddress } }],
  }] });
  const next = await signedInput(id);
  assert.equal(next.listingVersion, 2);
  const preview = await post(request({ ...prior, listingSignature: undefined }));
  assert.equal(preview.status, 200, "a prepared prior version previews its own Listing");
  assert.equal((await preview.json()).tx, null);
  await unresolved(await post(request(prior)), first.anchorAddress);
  // Without a saved preparation, a listed version the lookups cannot find is refused outright.
  db.prepare("DELETE FROM listing_preparations WHERE logical_address=?").run(first.logicalAddress);
  for (const listingSignature of [undefined, prior.listingSignature]) {
    const response = await post(request({ ...prior, listingSignature }));
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.match(body.error, /already published this version/);
    assert.equal(body.tx, undefined);
  }
  assert.equal((await post(request({ ...next, listingVersion: 3 }))).status, 400);
  assert.equal(state.nonceReads, 1, "past and future versions never obtain a nonce");
  const second = await prepare(next);
  assert.equal(second.listing.listingVersion, 2);
  assert.equal(state.nonceReads, 2);
});

test("the API route with trusted rail authority creates on producer-name absence without a resolver", async (t) => {
  const state = node(t);
  const signed = await signedInput("route-logical-occupancy");
  const routeBundle = join(bundleDirectory, "route-with-authority.mjs");
  await build({
    entryPoints: [join(app, "app/api/dacs/build-listing/route.ts")], outfile: routeBundle,
    bundle: true, platform: "node", format: "esm", packages: "external",
    plugins: [publicationBoundaries(), { name: "signed-rail-snapshot", setup(builder) {
      builder.onResolve({ filter: /\/listingOptions$/ }, () => ({ path: "signed-options", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
        export * from ${JSON.stringify(join(app, "src/catalog/listingOptions.ts"))};
        export const PUBLISHER_IN_CODE_RAIL_DEFINITIONS = ${JSON.stringify(rails)};
      `, resolveDir: app }));
    } }],
  });
  const route = await import(pathToFileURL(routeBundle).href);
  const response = await route.POST(request(signed));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.exists, false);
  assert.ok(body.tx);
  assert.equal(state.nonceReads, 1);
  await resumed(await route.POST(request(signed)), body);
  assert.equal(state.nonceReads, 1);
});

for (const [name, resolveVersion] of [
  ["indeterminate", async () => ({ status: "indeterminate", reason: "history index is incomplete" })],
  ["invalid", async () => null],
  ["multiple", async (logicalAddress, chainIdentity) => ({ status: "complete", logicalAddress, chainIdentity,
    nativeAddresses: [`stor-${"71".repeat(20)}`, `stor-${"72".repeat(20)}`] })],
]) test(`a configured ${name} resolver withholds preview and signed creation`, async (t) => {
  const state = node(t);
  const signed = await signedInput(`configured-${name}`);
  const builder = module.createBuildListingPost(rails, resolveVersion);
  for (const input of [{ ...signed, listingSignature: undefined }, signed]) {
    const response = await builder(request(input));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).tx, undefined);
  }
  assert.equal(state.nonceReads, 0);
});

test("a configured complete empty resolver permits the next signed Listing", async (t) => {
  const state = node(t);
  const signed = await signedInput("configured-empty");
  const response = await module.createBuildListingPost(rails, qualifiedEmpty)(request(signed));
  assert.equal(response.status, 200);
  assert.ok((await response.json()).tx);
  assert.equal(state.nonceReads, 1);
});

test("logical occupancy is resolved again on every request without caching success", async (t) => {
  const state = node(t);
  const signed = await signedInput("changing-occupancy");
  let calls = 0;
  const resolveVersion = async (logical, chain) => ++calls === 1 ? qualifiedEmpty(logical, chain)
    : { status: "indeterminate", reason: "history index is incomplete" };
  const builder = module.createBuildListingPost(rails, resolveVersion);
  const first = await builder(request({ ...signed, listingSignature: undefined }));
  assert.equal(first.status, 200);
  const later = await builder(request(signed));
  assert.equal(later.status, 503);
  assert.match((await later.json()).error, /history index is incomplete/);
  assert.equal(calls, 2);
  assert.equal(state.nonceReads, 0);
});

test("a request-supplied logical resolution cannot authorize creation", async (t) => {
  const state = node(t);
  const signed = await signedInput("untrusted-occupancy");
  const builder = module.createBuildListingPost(rails, async () => ({ status: "indeterminate", reason: "history index is incomplete" }));
  const response = await builder(request({ ...signed,
    occupancy: await qualifiedEmpty("forged", "forged"), nativeAddresses: [] }));
  assert.equal(response.status, 503);
  assert.equal(state.nonceReads, 0);
});

const logical = `dacs1:${encodeURIComponent(`did:demos:agent:${ownerHex}`)}:occupancy-unit:v1`;
const chain = "fixture-chain";
const complete = (nativeAddresses = []) => ({ status: "complete", logicalAddress: logical, chainIdentity: chain, nativeAddresses });
const resolveOccupancy = (resolver) => module.resolveListingVersionOccupancy(logical, chain, `0x${ownerHex}`, resolver);

for (const [name, reply] of [
  ["missing", null], ["malformed", []], ["incomplete", { status: "partial", nativeAddresses: [] }],
  ["wrong logical address", { ...complete(), logicalAddress: `${logical}2` }],
  ["wrong chain", { ...complete(), chainIdentity: "other-chain" }],
  ["missing locator list", { ...complete(), nativeAddresses: undefined }],
  ["malformed locator", complete(["not-a-native-address"])],
  ["ambiguous", complete([`stor-${"71".repeat(20)}`, `stor-${"72".repeat(20)}`])],
  ["duplicate locator", complete([`stor-${"71".repeat(20)}`, `stor-${"71".repeat(20)}`])],
  ["oversized", { ...complete(), padding: "x".repeat(1024 * 1024) }],
]) test(`${name} logical occupancy refuses absence`, async () => {
  const result = await resolveOccupancy(async () => reply);
  assert.equal(result.status, "indeterminate");
});

test("qualified complete logical occupancy can establish an unused version", async () => {
  assert.deepEqual(await resolveOccupancy(async () => complete()), { status: "absent" });
});

test("logical resolver failure preserves its cause", async () => {
  const result = await resolveOccupancy(async () => { throw new Error("history endpoint refused HTTP 403"); });
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, /history endpoint refused HTTP 403/);
});

for (const [name, message, cause] of [
  ["TimeoutError", "", /timed out/],
  ["AbortError", "", /aborted/],
  ["TimeoutError", "upstream stopped", /timed out.*upstream stopped/],
  ["AbortError", "upstream stopped", /aborted.*upstream stopped/],
]) test(`logical resolver preserves ${name} cause with ${message ? "a message" : "an empty message"}`, async () => {
  const result = await resolveOccupancy(async () => { throw new DOMException(message, name); });
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, cause);
});

test("an empty ordinary resolver error retains a nonempty cause", async () => {
  const result = await resolveOccupancy(async () => { throw new Error(""); });
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, /resolver error/);
});

test("a non-Error resolver failure retains the unknown-cause classification", async () => {
  const result = await resolveOccupancy(async () => { throw null; });
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, /unknown resolver failure/);
});

test("the caller times out a logical resolver that ignores cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const pending = resolveOccupancy(async (_logical, _chain, abort) => { signal = abort; return new Promise(() => {}); });
  t.mock.timers.runAll();
  const result = await pending;
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, /timed out/);
  assert.equal(signal.aborted, true);
});

const nativeRecord = (overrides = {}) => ({ success: true, data: {}, owner: `0x${ownerHex}`,
  programName: "independent-publisher", metadata: { logicalAddress: logical }, ...overrides });
for (const [name, response] of [
  ["missing anchor", () => Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 })],
  ["denied anchor", () => new Response(null, { status: 403 })],
  ["invalid anchor payload", () => Response.json(nativeRecord({ data: [] }))],
  ["oversized anchor", () => Response.json(nativeRecord({ padding: "x".repeat(1024 * 1024) }))],
  ["wrong owner", () => Response.json(nativeRecord({ owner: `0x${"74".repeat(32)}` }))],
  ["missing logical metadata", () => Response.json(nativeRecord({ metadata: {} }))],
  ["wrong logical metadata", () => Response.json(nativeRecord({ metadata: { logicalAddress: `${logical}2` } }))],
  ["conflicting logical aliases", () => Response.json(nativeRecord({ metadata: { logicalAddress: logical, logical_address: `${logical}2` } }))],
  ["wrong native metadata", () => Response.json(nativeRecord({ storageAddress: `stor-${"75".repeat(20)}` }))],
  ["invalid program name", () => Response.json(nativeRecord({ programName: "invalid:name" }))],
]) test(`${name} at a logically resolved locator cannot establish absence`, async (t) => {
  t.mock.method(globalThis, "fetch", response);
  const result = await resolveOccupancy(async () => complete([`stor-${"73".repeat(20)}`]));
  assert.equal(result.status, "indeterminate");
});

test("native binding resolution accepts the Standard's logical_address metadata spelling", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json(nativeRecord({ metadata: { logical_address: logical } })));
  const result = await resolveOccupancy(async () => complete([`stor-${"73".repeat(20)}`]));
  assert.equal(result.status, "present");
});

test("the logical resolution deadline also cancels a stalled native response body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let markStarted;
  let readSignal;
  const started = new Promise((resolve) => { markStarted = resolve; });
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    readSignal = init.signal;
    const response = new Response(new ReadableStream({ start(controller) {
      readSignal.addEventListener("abort", () => controller.error(readSignal.reason), { once: true });
    } }));
    markStarted();
    return response;
  });
  const pending = resolveOccupancy(async () => complete([`stor-${"73".repeat(20)}`]));
  await started;
  t.mock.timers.runAll();
  const result = await pending;
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, /timed out/);
  assert.equal(readSignal.aborted, true);
});

for (const [name, respond, cause] of [
  ["timeout", () => { throw new DOMException("deadline", "TimeoutError"); }, /timed out/],
  ["empty-message timeout", () => { throw new DOMException("", "TimeoutError"); }, /timed out/],
  ["empty-message abort", () => { throw new DOMException("", "AbortError"); }, /timed out/],
  ["HTTP refusal", () => new Response(null, { status: 403 }), /HTTP 403/],
  ["transport failure", () => { throw new TypeError("fetch failed"); }, /could not be reached/],
  ["malformed JSON", () => new Response("{"), /invalid JSON/],
  ["oversized reply", () => Response.json(nativeRecord({ padding: "x".repeat(1024 * 1024) })), /byte limit/],
]) test(`logical native read preserves its ${name} cause`, async (t) => {
  t.mock.method(globalThis, "fetch", respond);
  const result = await resolveOccupancy(async () => complete([`stor-${"73".repeat(20)}`]));
  assert.equal(result.status, "indeterminate");
  assert.match(result.reason, cause);
});
