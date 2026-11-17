import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalize, contentHash, stripSignature } from "../src/catalog/canonical.js";
import { catalogBundleBindings, logicalBundleAddress, verifyBundleBinding } from "../src/catalog/bundleBinding.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "../src/catalog/nodeDeployment.js";
import { MAX_REGISTRATION_BUNDLE_BINDINGS } from "../src/catalog/registration.js";
import type { BundleBinding, Registration } from "../src/catalog/types.js";
import { onPinnedChain } from "./fixtures/pinned-node.js";

const directory = mkdtempSync(join(tmpdir(), "dacs-registration-bindings-"));
process.env.DACS_DIRECTORY_DATA = directory;
const store = await import("../src/catalog/store.js");
const { reindexAll } = await import("../src/catalog/reindexCore.js");
test.after(() => rmSync(directory, { recursive: true, force: true }));

// Ephemeral test identities, unrelated to wallets or live nodes.
const identities = Array.from({ length: 2 }, () => {
  const keys = crypto.generateKeyPairSync("ed25519");
  const claim = `did:demos:agent:${keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex")}`;
  return { claim, sign: (message: string) => crypto.sign(null, Buffer.from(message), keys.privateKey).toString("base64url") };
});
function binding(jobId: string, n: number, role: BundleBinding["role"] = "buyer", signer = 0): BundleBinding {
  const scope = { bindingVersion: "1" as const, jobId, role, logicalAddress: logicalBundleAddress(jobId, role),
    nativeAddress: `stor-${n.toString(16).padStart(40, "0")}`,
    bundleContentHash: n.toString(16).padStart(64, "0"), signer: identities[signer].claim };
  return { ...scope, signature: { algorithm: "ed25519", signer: scope.signer,
    value: identities[signer].sign(`dacs-bundle-binding:v1:${contentHash(scope)}`) } };
}
const registration = (bundleBindings?: BundleBinding[], signer = 0): Registration => ({
  primaryClaim: identities[signer].claim, displayName: "Binding batching", listingAnchors: [],
  ...(bundleBindings ? { bundleBindings } : {}),
});

for (const count of [8, 40, 80]) test(`registration ingest groups each affected job once with ${count} incoming bindings per job`, async (t) => {
  // Include a prototype-shaped job ID and a job with no new bindings.
  const jobs = ["batch-registration", "__proto__", "untouched"];
  const sentinels = jobs.map((job, n) => binding(job, 10_000 + n));
  const a = Array.from({ length: count }, (_, n) => binding(jobs[0], n + 1));
  const roles: BundleBinding["role"][] = ["buyer", "seller", "orchestrator"];
  const b = Array.from({ length: count }, (_, n) => binding(jobs[1], n + 101, roles[n % roles.length], n % 2));
  const invalid = { ...binding("invalid-only", 999), signature: { ...a[0].signature, value: "invalid" } };
  const overCap = binding("over-registration-cap", 998);
  const regs = [
    registration([...a.slice(0, count / 2).reverse(), ...b.slice(0, count / 2), a[0], invalid]),
    registration([...b.slice(count / 2).reverse(), ...a.slice(count / 2), a[0], b[0], binding("new-job", 997)], 1),
    registration(),
    registration(Array.from({ length: MAX_REGISTRATION_BUNDLE_BINDINGS + 1 }, () => overCap)),
  ];
  const existing = Object.fromEntries(sentinels.map((value) => [value.jobId, [value]]));
  const sticky = ["prior-job\nseller\n" + identities[0].claim];
  store.publishCatalogChain({ catalogVersion: "1", generatedAt: 1, sellers: [] }, {
    schemaVersion: 10, lastSeenTxId: 0, listings: {}, deals: {},
    bundleBindings: { ...existing, "invalid-only": [invalid] }, bundleBindingOverflow: sticky,
  }, PINNED_DEMOS_CHAIN_IDENTITY);
  store.saveRegistrations(regs);

  // The original registration loop is the result oracle (after unchanged admission/verification).
  const expected: Record<string, BundleBinding[]> = { ...existing, "invalid-only": [] };
  let overflow = [...sticky];
  for (const reg of regs) {
    if ((reg.bundleBindings?.length ?? 0) > MAX_REGISTRATION_BUNDLE_BINDINGS) continue;
    for (const raw of reg.bundleBindings ?? []) {
      const value = await verifyBundleBinding(raw);
      if (!value) continue;
      const merged = catalogBundleBindings([...(expected[value.jobId] ?? []), value]);
      expected[value.jobId] = merged.bindings;
      overflow = [...new Set([...overflow, ...merged.overflowKeys])].sort();
    }
  }
  // Existing sentinels plus one early-arriving, non-duplicated incoming binding per affected job.
  const probes = [...sentinels, a[count / 2 - 1], b[1]];
  const sentinelInputs = probes.map((value) => Buffer.from(canonicalize(stripSignature(value))));
  const inputs: Array<() => crypto.BinaryLike[]> = [];
  const createHash = crypto.createHash;
  t.mock.method(crypto, "createHash", (...args: Parameters<typeof crypto.createHash>) => {
    const hash = createHash(...args);
    const update = t.mock.method(hash, "update");
    inputs.push(() => update.mock.calls.map((call) => call.arguments[0]));
    return hash;
  });
  syncBuiltinESMExports();
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const call = JSON.parse(String(init?.body)).params?.[0];
    assert.equal(call?.message, "getTransactions", "only the offline empty chain is read");
    return Response.json({ result: 200, response: [] });
  });
  let hashCounts: number[];
  try {
    const summary = await reindexAll({ nodeDeployment: onPinnedChain, log: () => {}, resolveIdentities: async () => [] });
    assert.equal(summary.sellers, 3, "the over-limit registration is refused before ingest");
    const actual = store.loadScanState();
    assert.deepEqual({ ...actual.bundleBindings }, expected, "exact records and deterministic order match the old loop");
    assert.deepEqual(actual.bundleBindingOverflow, overflow, "sticky overflow remains sorted and deduplicated");
    assert.equal(actual.bundleBindings?.[jobs[0]].length, count + 1, "the catalog retains every valid record beyond the resolution cap");
    assert.equal(overflow.includes(`${jobs[0]}\nbuyer\n${identities[0].claim}`), count >= 32);
    assert.equal(Object.hasOwn(actual.bundleBindings!, overCap.jobId), false);
    const hashed = inputs.flatMap((read) => read()).map((input) => typeof input === "string"
      ? Buffer.from(input) : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
    hashCounts = sentinelInputs.map((sentinel) => hashed.filter((input) => input.equals(sentinel)).length);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  t.diagnostic(`existing/incoming hash counts for ${count} incoming/job: ${hashCounts.join(", ")}`);
  // An affected existing binding is hashed by verification, persisted-set sanitation, and ONE
  // registration merge. An untouched job only incurs the first two. An incoming binding is hashed
  // by admission verification and ONE merge, so neither existing nor incoming records are re-grouped.
  assert.deepEqual(hashCounts, [3, 3, 2, 2, 2], "grouping passes scale with affected jobs, not incoming binding count");
});
