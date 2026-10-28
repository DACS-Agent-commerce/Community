import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { NextRequest } from "next/server.js";

const app = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "listing-preparations-"));
const bundleDirectory = mkdtempSync(join(app, ".listing-preparations-"));
const bundle = join(bundleDirectory, "index.mjs");
process.env.DACS_DIRECTORY_DATA = directory;
const boundaries = resolve(app, "test/fixtures/listing-preparation-boundaries.mjs");
await build({
  stdin: { contents: `export * from './src/catalog/buildListing.ts'; export * from './src/catalog/store.ts';
    export { POST as routePost } from './app/api/dacs/build-listing/route.ts';
    export { nodeDeployment } from './test/fixtures/listing-preparation-boundaries.mjs';`, resolveDir: app },
  outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{ name: "publication-boundaries", setup(builder) {
    builder.onLoad({ filter: /[\/]src[\/]catalog[\/]store\.ts$/ }, ({ path }) => ({
      contents: readFileSync(path, "utf8") + `
export const preparationJournalTriggers = () => db.prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' AND name LIKE 'journal_listing_preparations_%'").all();`,
      loader: "ts", resolveDir: resolve(app, "src/catalog"),
    }));
    builder.onResolve({ filter: /^next\/server$/ }, () => ({ path: "next/server.js", external: true }));
    builder.onResolve({ filter: /^@kynesyslabs\/dacs\// }, () => ({ path: boundaries }));
    builder.onResolve({ filter: /\/(sdkListingValidation|listingVerification|listingFinality|registrationSig|wellknown)(\.js)?$/ },
      () => ({ path: boundaries }));
    builder.onResolve({ filter: /^\.\/(wellknown|listingVerification)\.js$/ }, () => ({ path: boundaries }));
  } }],
});
const module = await import(pathToFileURL(bundle).href);
const rails = [{ railId: "ap2:stripe-paymentintents", railVersion: 1, phaseHandler: "pay-ap2", governanceAnchoring: "in-code", signatureValid: true }];
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
    return Response.json({ success: true, data: state.published.listing, owner: `0x${ownerHex}`, programName: state.published.programName });
  });
  return state;
}
async function signedInput(id, overrides = {}, handler = post) {
  const input = { ...inputFor(id), ...overrides };
  const identityResponse = await handler(request(input));
  assert.equal(identityResponse.status, 200);
  const identity = await identityResponse.json();
  const authenticated = { ...input, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: walletSign(identity.identityMessage) };
  const previewResponse = await handler(request(authenticated));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.tx, null);
  return { ...authenticated, listingSignature: walletSign(preview.message) };
}
async function prepare(input, handler = post) {
  const response = await handler(request(input));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.tx);
  return body;
}
async function unresolved(response, anchor, logicalAddress) {
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /preparation.*unresolved/i);
  assert.equal(body.anchorAddress, anchor);
  if (logicalAddress) assert.equal(body.logicalAddress, logicalAddress);
  for (const field of ["tx", "listing", "message", "publicationReady", "railResolution"]) {
    assert.equal(body[field], undefined, `${field} must not be released`);
  }
}
async function resumed(response, first) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.anchorAddress, first.anchorAddress, "the same signed Listing must never receive a different anchor");
  assert.equal(JSON.stringify(body.tx), JSON.stringify(first.tx), "the exact saved transaction bytes, never a rebuilt one");
  assert.deepEqual(body.listing, first.listing, "response Listing comes from the saved transaction");
  assert.equal(body.contentHash, first.contentHash);
  assert.equal(body.message, `dacs-listing:v1:${first.contentHash}`);
}

const authorizedRails = [
  ...rails,
  { ...rails[0], railId: "x402:default", phaseHandler: "pay-x402" },
  { ...rails[0], railId: "demos-native:DEM", phaseHandler: "pay-dem" },
];
const railPair = async (id, savedRail = authorizedRails[0], retryRail = authorizedRails[1]) => {
  const originalHandler = module.createBuildListingPost([savedRail]);
  const signed = await signedInput(id, { rails: [savedRail.railId] }, originalHandler);
  const first = await prepare(signed, originalHandler);
  return { signed, first, originalHandler, retryRail,
    retryHandler: module.createBuildListingPost([retryRail]), retry: { ...signed, rails: [retryRail.railId] } };
};
function unchangedPreparation(first, state) {
  const row = db.prepare("SELECT anchor_address, transaction_json FROM listing_preparations WHERE logical_address=?").get(first.logicalAddress);
  assert.equal(row.anchor_address, first.anchorAddress);
  assert.equal(row.transaction_json, JSON.stringify(first.tx));
  assert.equal(state.nonceReads, 1, "retained retries must not request a replacement nonce");
}
async function readback(response, first) {
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.exists, true);
  assert.equal(body.anchorAddress, first.anchorAddress);
  assert.deepEqual(body.listing, first.listing);
  assert.equal(body.tx, null);
}
for (const age of [0, 900_000, 900_001, 960_000]) {
for (const savedRail of authorizedRails) for (const retryRail of authorizedRails) {
  if (savedRail === retryRail) continue;
  test(`saved ${savedRail.railId} refuses ${retryRail.railId} authority before and after readback at age ${age}`, async (t) => {
    const state = node(t);
    const pair = await railPair(`rail-${savedRail.phaseHandler}-${retryRail.phaseHandler}-${age}`, savedRail, retryRail);
    t.mock.method(Date, "now", () => clock + age);
    assert.equal((await pair.retryHandler(request(pair.signed))).status, 409, "the saved rail is no longer authorized");
    await resumed(await pair.originalHandler(request(pair.signed)), pair.first);
    await unresolved(await pair.retryHandler(request(pair.retry)), pair.first.anchorAddress, pair.first.logicalAddress);
    state.published = pair.first;
    await readback(await pair.originalHandler(request(pair.signed)), pair.first);
    await unresolved(await pair.retryHandler(request(pair.retry)), pair.first.anchorAddress, pair.first.logicalAddress);
    unchangedPreparation(pair.first, state);
  });
}
}
test("identity-only prepared readback still binds the saved rail", async (t) => {
  const state = node(t);
  const pair = await railPair("rail-readback-identity");
  state.published = pair.first;
  await readback(await pair.originalHandler(request({ ...pair.signed, listingSignature: undefined })), pair.first);
  await unresolved(await pair.retryHandler(request({ ...pair.retry, listingSignature: undefined })),
    pair.first.anchorAddress, pair.first.logicalAddress);
  unchangedPreparation(pair.first, state);
});
test("an already catalogued prepared version keeps read-only recovery bound to its rail", async (t) => {
  const state = node(t);
  const pair = await railPair("rail-readback-older");
  state.published = pair.first;
  module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [{ primaryClaim: inputFor("").claim,
    displayName: inputFor("").name, listings: [{ listingId: pair.signed.serviceId, version: 1,
      anchor: { kind: "storage-program", locator: pair.first.anchorAddress } }] }] });
  try {
    await readback(await pair.originalHandler(request(pair.signed)), pair.first);
    await unresolved(await pair.retryHandler(request(pair.retry)), pair.first.anchorAddress, pair.first.logicalAddress);
  } finally { module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [] }); }
  unchangedPreparation(pair.first, state);
});
test("legacy-name prepared readback still binds the saved rail", async (t) => {
  const state = node(t);
  const pair = await railPair("rail-readback-legacy");
  state.published = { ...pair.first, programName: `dacs1-${Buffer.from(pair.first.logicalAddress).toString("base64url")}` };
  await readback(await pair.originalHandler(request(pair.signed)), pair.first);
  await unresolved(await pair.retryHandler(request(pair.retry)), pair.first.anchorAddress, pair.first.logicalAddress);
  unchangedPreparation(pair.first, state);
});
test("concurrent prepared readback retries succeed only for the saved rail", async (t) => {
  const state = node(t);
  const pair = await railPair("rail-readback-concurrent");
  state.published = pair.first;
  const responses = await Promise.all([pair.originalHandler(request(pair.signed)),
    pair.retryHandler(request(pair.retry)), pair.retryHandler(request(pair.retry))]);
  await readback(responses[0], pair.first);
  for (const response of responses.slice(1)) await unresolved(response, pair.first.anchorAddress, pair.first.logicalAddress);
  unchangedPreparation(pair.first, state);
});

// Exercise the optional SDK field and every existing rail/handler guard using
// signed producer fixtures, without changing committed preparation records.
for (const [name, alter, allowed] of [
  ["missing rails", (listing) => { delete listing.acceptedRails; }, false],
  ["empty rails", (listing) => { listing.acceptedRails = []; }, false],
  ["matching singleton", () => {}, true],
  ["multiple rails", (listing) => { listing.acceptedRails.push({ ...listing.acceptedRails[0] }); }, false],
  ["wrong rail", (listing) => { listing.acceptedRails[0].railId = "x402:default"; }, false],
  ["missing handler", (listing) => { listing.pipeline = listing.pipeline.filter((phase) => !phase.kind.startsWith("pay-")); }, false],
  ["extra handler", (listing) => { listing.pipeline.push(listing.pipeline.find((phase) => phase.kind.startsWith("pay-"))); }, false],
  ["wrong handler", (listing) => { listing.pipeline.find((phase) => phase.kind.startsWith("pay-")).kind = "pay-x402"; }, false],
  ["missing parameter", (listing) => { delete listing.pipeline.find((phase) => phase.kind.startsWith("pay-")).parameters; }, false],
  ["wrong parameter", (listing) => { listing.pipeline.find((phase) => phase.kind.startsWith("pay-")).parameters.rail = "x402:default"; }, false],
]) {
  test(`saved rail boundary refuses ${name} unless it matches, in both response paths`, async (t) => {
    const state = node(t);
    const signed = await signedInput(`rail-boundary-${name.replaceAll(" ", "-")}`);
    const preview = await (await post(request({ ...signed, listingSignature: undefined }))).json();
    const listing = preview.listing;
    alter(listing);
    const { contentHash } = await import(pathToFileURL(boundaries).href);
    const hash = contentHash(listing);
    signed.listingSignature = walletSign(`dacs-listing:v1:${hash}`);
    listing.signature = { algorithm: "ed25519", signer: signed.claim, value: Buffer.from(signed.listingSignature, "hex").toString("base64url") };
    const first = { ...preview, listing, contentHash: hash, anchorAddress: `stor-${"b".repeat(40)}`,
      tx: { content: { data: ["storageProgram", { data: listing, metadata: { contentHash: hash } }] } } };
    const chain = process.env.DEMOS_CHAIN_IDENTITY ?? "d59b54c2f70305e03d3a7e4d469f38295ffe4e4a62cb59b9f887057d0e5ca4bc";
    assert.equal(module.saveListingPreparation(chain, first.logicalAddress,
      { anchorAddress: first.anchorAddress, transactionJson: JSON.stringify(first.tx) }), true);
    if (allowed) await resumed(await post(request(signed)), first);
    else await unresolved(await post(request(signed)), first.anchorAddress, first.logicalAddress);
    state.published = first;
    if (allowed) await readback(await post(request(signed)), first);
    else await unresolved(await post(request(signed)), first.anchorAddress, first.logicalAddress);
    assert.equal(state.nonceReads, 0);
  });
}
test("substituting a rail before the first save fails the fresh Listing signature check", async (t) => {
  const state = node(t);
  const signed = await signedInput("rail-fresh");
  const response = await module.createBuildListingPost([authorizedRails[1]])(request({ ...signed, rails: [authorizedRails[1].railId] }));
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT count(*) AS n FROM listing_preparations WHERE logical_address LIKE '%:rail-fresh:v1'").get().n, 0);
  assert.equal(state.nonceReads, 0);
});

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
  const changed = await signedInput("changed-candidate", { description: "Different signed contents" });
  t.mock.method(Date, "now", () => clock + 60_000);
  const resigned = await signedInput("changed-candidate");
  const first = await prepare(original);
  await unresolved(await post(request(resigned)), first.anchorAddress);
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


test("a prepared preview returns only its saved anchor without requesting another Listing signature", async (t) => {
  node(t);
  const signed = await signedInput("prepared-preview");
  const first = await prepare(signed);
  await unresolved(await post(request({ ...signed, listingSignature: undefined })), first.anchorAddress);
});

test("an exact repeat uses stored bytes even when valid request fields change with both signatures retained", async (t) => {
  const state = node(t);
  const signed = await signedInput("changed-body-same-signatures");
  const first = await prepare(signed);
  await resumed(await post(request({ ...signed, name: "New title", description: "New description",
    category: "services.changed", pricing: { kind: "fixed", amount: "9", currency: "USD" } })), first);
  assert.equal(state.nonceReads, 1);
});

test("an invalid identity cannot learn a prepared anchor", async (t) => {
  node(t);
  const signed = await signedInput("invalid-prepared-identity");
  await prepare(signed);
  const response = await post(request({ ...signed, identitySignature: "00".repeat(64) }));
  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.anchorAddress, undefined);
  assert.equal(body.tx, undefined);
});

test("an expired valid nonrepeat is refused before any network read and reveals no prepared anchor", async (t) => {
  node(t);
  const signed = await signedInput("expired-nonrepeat");
  const changed = await signedInput("expired-nonrepeat", { description: "Other signed draft" });
  await prepare(signed);
  t.mock.method(Date, "now", () => clock + 16 * 60_000);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("expiry must precede reads"); });
  const response = await post(request(changed));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.match(body.error, /identity presentation expired/);
  assert.equal(body.anchorAddress, undefined);
  assert.equal(body.tx, undefined);
});

test("a failed refresh cannot undo a preparation or allow a re-signed replacement", async (t) => {
  node(t);
  const signed = await signedInput("refresh-revert");
  t.mock.method(Date, "now", () => clock + 1);
  const resigned = await signedInput("refresh-revert");
  module.openChainReadWindow();
  const first = await prepare(signed);
  module.revertChainReadWindow();
  await resumed(await post(request(signed)), first);
  await unresolved(await post(request(resigned)), first.anchorAddress);
});

test("preparations have no undo-journal triggers and persistent UPDATE and DELETE guards", async (t) => {
  node(t);
  const first = await prepare(await signedInput("append-only"));
  module.openChainReadWindow();
  try {
    assert.deepEqual(module.preparationJournalTriggers(), []);
    assert.equal(db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type='trigger' AND tbl_name='listing_preparations'").get().count, 2);
    for (const sql of ["UPDATE listing_preparations SET transaction_json='replaced' WHERE logical_address=?",
      "DELETE FROM listing_preparations WHERE logical_address=?"]) {
      assert.throws(() => db.prepare(sql).run(first.logicalAddress), /append.only/);
    }
  } finally { module.revertChainReadWindow(); }
});

const childScript = resolve(app, "test/fixtures/listing-preparation-worker.mjs");
const childArguments = (input, options = {}) => [childScript, bundle, JSON.stringify({ input, rails, clock, ...options })];

test("a crashed refresh window retains the preparation through recovery and refuses a re-signed replacement", async (t) => {
  node(t);
  const signed = await signedInput("crashed-window");
  t.mock.method(Date, "now", () => clock + 1);
  const resigned = await signedInput("crashed-window");
  const crashed = spawnSync(process.execPath, childArguments(signed, { crash: true }), { encoding: "utf8", timeout: 15_000 });
  assert.equal(crashed.status, 77, crashed.stderr);
  const row = db.prepare("SELECT anchor_address, transaction_json FROM listing_preparations WHERE logical_address LIKE '%:crashed-window:v1'").get();
  assert.ok(row, "the child committed the preparation before crashing without a response");
  module.revertChainReadWindow();
  const tx = JSON.parse(row.transaction_json);
  await resumed(await post(request(signed)), { anchorAddress: row.anchor_address, tx, listing: tx.content.data[1].data,
    contentHash: tx.content.data[1].metadata.contentHash });
  await unresolved(await post(request(resigned)), row.anchor_address);
});

async function racingProcesses(inputs, options = {}) {
  const children = inputs.map((input, index) => spawn(process.execPath, childArguments(input, { race: true, nonce: index + 10, ...options }),
    { stdio: ["ignore", "ignore", "pipe", "ipc"] }));
  try {
    return await new Promise((resolveResult, reject) => {
      const ready = new Set();
      const results = [];
      const timer = setTimeout(() => reject(new Error("preparation workers timed out")), 15_000);
      for (const child of children) {
        let errors = "";
        child.stderr.on("data", (chunk) => { errors += chunk; });
        child.on("error", reject);
        child.on("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}: ${errors}`)); });
        child.on("message", (message) => {
          if (message.ready) {
            ready.add(child);
            if (ready.size === children.length) for (const worker of children) worker.send("continue");
          } else {
            results.push(message);
            if (results.length === children.length) { clearTimeout(timer); resolveResult(results); }
          }
        });
      }
    });
  } finally { for (const child of children) child.kill(); }
}

test("a fresh process refuses a retained transaction under substituted rail authority", async (t) => {
  const state = node(t);
  const pair = await railPair("rail-restart");
  const [result] = await racingProcesses([pair.retry], { race: false, synchronize: true, forbidNonce: true, rails: [pair.retryRail] });
  await unresolved(Response.json(result.body, { status: result.status }), pair.first.anchorAddress);
  unchangedPreparation(pair.first, state);
});

test("a restarted process binds expired prepared readback to the saved rail", async (t) => {
  const state = node(t);
  const pair = await railPair("rail-readback-restart");
  const [matching] = await racingProcesses([pair.signed], { race: false, synchronize: true,
    forbidNonce: true, published: pair.first, clock: clock + 960_000 });
  await readback(Response.json(matching.body, { status: matching.status }), pair.first);
  const [changed] = await racingProcesses([pair.retry], { race: false, synchronize: true,
    forbidNonce: true, published: pair.first, clock: clock + 960_000, rails: [pair.retryRail] });
  await unresolved(Response.json(changed.body, { status: changed.status }), pair.first.anchorAddress, pair.first.logicalAddress);
  unchangedPreparation(pair.first, state);
});

test("a reverted refresh preserves the saved rail release check", async (t) => {
  const state = node(t);
  module.openChainReadWindow();
  let pair;
  try { pair = await railPair("rail-refresh-revert"); }
  finally { module.revertChainReadWindow(); }
  await unresolved(await pair.retryHandler(request(pair.retry)), pair.first.anchorAddress);
  unchangedPreparation(pair.first, state);
});

test("crash recovery refuses a saved transaction under substituted rail authority", async (t) => {
  const state = node(t);
  const signed = await signedInput("rail-crash");
  const crashed = spawnSync(process.execPath, childArguments(signed, { crash: true }), { encoding: "utf8", timeout: 15_000 });
  assert.equal(crashed.status, 77, crashed.stderr);
  const row = db.prepare("SELECT anchor_address, transaction_json FROM listing_preparations WHERE logical_address LIKE '%:rail-crash:v1'").get();
  assert.ok(row);
  module.revertChainReadWindow();
  const response = await module.createBuildListingPost([authorizedRails[1]])(request({ ...signed, rails: [authorizedRails[1].railId] }));
  await unresolved(response, row.anchor_address);
  assert.equal(db.prepare("SELECT transaction_json FROM listing_preparations WHERE anchor_address=?").get(row.anchor_address).transaction_json, row.transaction_json);
  assert.equal(state.nonceReads, 0, "only the crashed worker read a nonce");
});

for (const processes of [false, true]) {
  test(`concurrent retained retries with substituted rail authority refuse in ${processes ? "two processes" : "one process"}`, async (t) => {
    const state = node(t);
    const pair = await railPair(`rail-concurrent-${processes}`);
    const responses = processes
      ? (await racingProcesses([pair.retry, pair.retry], { race: false, synchronize: true, forbidNonce: true, rails: [pair.retryRail] }))
        .map(({ status, body }) => Response.json(body, { status }))
      : await Promise.all([pair.retryHandler(request(pair.retry)), pair.retryHandler(request(pair.retry))]);
    for (const response of responses) await unresolved(response, pair.first.anchorAddress);
    unchangedPreparation(pair.first, state);
  });
}

for (const identical of [false, true]) {
  test(`a synchronized two-process ${identical ? "identical" : "different"} request race releases only the winner's bytes`, async (t) => {
    node(t);
    const signed = await signedInput(`process-race-${identical}`);
    const other = identical ? signed : await signedInput(`process-race-${identical}`, { description: "Other process draft" });
    const results = await racingProcesses([signed, other]);
    assert.deepEqual(results.map(({ status }) => status).sort(), identical ? [200, 200] : [200, 409]);
    const winner = results.find(({ body }) => body.tx).body;
    const row = db.prepare("SELECT transaction_json FROM listing_preparations WHERE logical_address=?").get(winner.logicalAddress);
    for (const { body } of results) {
      assert.equal(body.anchorAddress, winner.anchorAddress);
      if (body.tx) assert.equal(JSON.stringify(body.tx), row.transaction_json);
    }
  });
}

test("the builder isolates configured chains and successive logical versions", async (t) => {
  node(t);
  const signed = await signedInput("chain-and-version");
  const first = await prepare(signed);
  const configured = process.env.DEMOS_CHAIN_IDENTITY;
  try {
    process.env.DEMOS_CHAIN_IDENTITY = "fixture-other-chain";
    const otherChain = await prepare(signed);
    assert.notEqual(otherChain.anchorAddress, first.anchorAddress);
    assert.equal(module.loadListingPreparation("fixture-other-chain", first.logicalAddress).transactionJson, JSON.stringify(otherChain.tx));
  } finally {
    if (configured === undefined) delete process.env.DEMOS_CHAIN_IDENTITY;
    else process.env.DEMOS_CHAIN_IDENTITY = configured;
  }
  module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [{ primaryClaim: inputFor("").claim,
    displayName: inputFor("").name, listings: [{ listingId: "chain-and-version", version: 1,
      anchor: { kind: "storage-program", locator: first.anchorAddress } }] }] });
  try {
    const v2 = await prepare(await signedInput("chain-and-version"));
    assert.notEqual(v2.logicalAddress, first.logicalAddress);
    assert.equal(v2.listing.listingVersion, 2);
    assert.notEqual(v2.anchorAddress, first.anchorAddress);
  } finally { module.saveCatalog({ catalogVersion: "1", generatedAt: clock, sellers: [] }); }
});


test("two sellers using the same Listing ID and version have separate preparations", async (t) => {
  node(t);
  const first = await prepare(await signedInput("separate-sellers"));
  const otherKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 13)]),
    format: "der", type: "pkcs8" });
  const otherHex = createPublicKey(otherKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const input = { ...inputFor("separate-sellers"), claim: `did:demos:agent:${otherHex}` };
  const identity = await (await post(request(input))).json();
  const otherSign = (message) => sign(null, Buffer.from(message), otherKey).toString("hex");
  const authenticated = { ...input, listingVersion: identity.listingVersion, identityPresentedAt: identity.identityPresentedAt,
    identitySignature: otherSign(identity.identityMessage) };
  const preview = await (await post(request(authenticated))).json();
  const other = await prepare({ ...authenticated, listingSignature: otherSign(preview.message) });
  assert.notEqual(other.logicalAddress, first.logicalAddress);
  assert.notEqual(other.anchorAddress, first.anchorAddress);
});
