import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { NextRequest } from "next/server.js";

const app = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "listing-preparations-"));
const bundleDirectory = mkdtempSync(join(app, "node_modules", ".listing-preparations-"));
const bundle = join(bundleDirectory, "index.mjs");
process.env.DACS_DIRECTORY_DATA = directory;
const boundaries = resolve(app, "test/fixtures/listing-preparation-boundaries.mjs");
await build({
  stdin: { contents: `export * from './src/catalog/buildListing.ts'; export * from './src/catalog/store.ts';
    export { POST as routePost } from './app/api/dacs/build-listing/route.ts';
    export { nodeDeployment } from './test/fixtures/listing-preparation-boundaries.mjs';`, resolveDir: app },
  outfile: bundle, bundle: true, platform: "node", format: "esm", packages: "external",
  plugins: [{ name: "publication-boundaries", setup(builder) {
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
