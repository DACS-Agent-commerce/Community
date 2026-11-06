import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { contentHash } from "../src/catalog/canonical.js";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { logicalBundleAddress } from "../src/catalog/bundleBinding.js";
import { onPinnedChain } from "./fixtures/pinned-node.js";

// The bundle route serves the stored bindings without re-verifying them, so every writer into that
// store must refuse a binding that fails BB-4: the registration route, the reindex (registrations and
// the persisted set) and the chain scan. (The well-known crawl is covered in catalog-routes.test.ts.)
const dataDirectory = mkdtempSync(join(tmpdir(), "catalog-binding-writers-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
process.env.DACS_SCAN_FINALITY_DEPTH = "0";
const store = await import("../src/catalog/store.js");
const { scanChain } = await import("../src/catalog/scan.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
const register = await import("../app/api/dacs/register/route.js");
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; rmSync(dataDirectory, { recursive: true, force: true }); });

type Obj = Record<string, unknown>;
const seeds = [61, 62].map((n) => new Uint8Array(32).fill(n));
const signers = seeds.map((seed) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`);
const native = (n: number) => `stor-${n.toString(16).padStart(40, "0")}`;
const signScope = (scope: Obj, seed = 0) => ({ ...scope, signature: { signer: signers[0], algorithm: "ed25519",
  value: Buffer.from(ed25519Sign(Buffer.from(`dacs-bundle-binding:v1:${contentHash(scope)}`), privateKeyFromSeed(seeds[seed]))).toString("base64url") } });
const scopeFor = (job: string, n: number): Obj => ({ bindingVersion: "1", jobId: job, role: "buyer", logicalAddress: logicalBundleAddress(job, "buyer"),
  nativeAddress: native(n), bundleContentHash: "a".repeat(64), signer: signers[0] });
const valid = (job: string, n = 1) => signScope(scopeFor(job, n));
/** Each fails BB-4: signed by another key, signed for another job, and missing a required member. */
function refused(job: string): Obj[] {
  const { nativeAddress: _omitted, ...incomplete } = scopeFor(job, 3);
  return [signScope(scopeFor(job, 2), 1), { ...valid("some-other-job", 4), jobId: job }, signScope(incomplete)];
}
const hashes = (values: Obj[]) => values.map(contentHash).sort();
const stored = (job: string) => hashes((store.loadScanState().bundleBindings?.[job] ?? []) as unknown as Obj[]);

test("registration route refuses a binding that fails BB-4 and stores nothing", async () => {
  const job = "writer-register";
  const post = (bundleBindings: Obj[], primaryClaim = signers[0]) => register.POST(new NextRequest("https://directory.example/api/dacs/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ primaryClaim, displayName: "Writer test", listingAnchors: [], bundleBindings }) }));
  for (const bad of refused(job)) {
    assert.equal((await post([valid(job), bad])).status, 400, "one bad binding refuses the whole registration");
    assert.deepEqual(store.loadRegistrations(), [], "nothing was stored");
  }
  assert.equal((await post([valid(job)])).status, 200, "the same registration with only the valid binding is accepted");
  assert.deepEqual(hashes(store.loadRegistrations()[0].bundleBindings as unknown as Obj[]), hashes([valid(job)]));
});

test("reindex drops a binding that fails BB-4 from registrations and from the persisted set", async () => {
  const stateJob = "writer-reindex-state";
  const registrationJob = "writer-reindex-registration";
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.ok(!path.startsWith("/storage-program/"), "no program is read");
    const call = JSON.parse(String(init?.body)).params?.[0];
    return Response.json({ result: 200, response: call?.message === "getTransactions" ? [] : null });
  };
  store.saveScanState({ schemaVersion: 10, lastSeenTxId: 0, listings: {}, deals: {},
    bundleBindings: { [stateJob]: [valid(stateJob), ...refused(stateJob)] as never } });
  store.saveRegistrations([{ primaryClaim: signers[1], displayName: "Writer test", listingAnchors: [],
    bundleBindings: [valid(registrationJob), ...refused(registrationJob)] as never }]);
  await reindexAll({ nodeDeployment: onPinnedChain, log: () => {}, resolveIdentities: async () => [] });
  assert.deepEqual(stored(stateJob), hashes([valid(stateJob)]), "the persisted set keeps only the valid binding");
  assert.deepEqual(stored(registrationJob), hashes([valid(registrationJob)]), "the registration's bad bindings are not carried");
});

test("chain scan drops a binding that fails BB-4", async () => {
  const job = "writer-scan";
  const programs = new Map([valid(job), ...refused(job)].map((value, n) => [native(500 + n), value]));
  const transactions = [...programs.keys()].map((address, n) => ({ id: n + 1, content: { memo: address } })).reverse();
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.startsWith("/storage-program/")) {
      const data = programs.get(path.slice("/storage-program/".length));
      assert.ok(data);
      return Response.json({ success: true, owner: `0x${signers[0].slice(-64)}`, programName: `binding-${path.slice(-40)}`, data });
    }
    const call = JSON.parse(String(init?.body)).params?.[0];
    return Response.json({ result: 200, response: call.data.start === "latest" ? transactions : [] });
  };
  const scan = await scanChain(null, { maxTxs: 100, sinceTxId: 0 });
  assert.equal(scan.complete, true);
  assert.equal(scan.omittedBindings, 3);
  assert.deepEqual(hashes(scan.bundleBindings.get(job) as unknown as Obj[]), hashes([valid(job)]));
  assert.deepEqual([...scan.bundleBindings.keys()], [job], "a binding filed under another job is not kept either");
});
