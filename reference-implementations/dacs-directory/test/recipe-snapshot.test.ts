import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { SelfSignedAuthoritySchemeError, resolveConfiguredRecipeSnapshot, type RecipePolicy } from "../src/catalog/recipePolicy.js";
import { matchesVetRequirement } from "../src/catalog/vetClaimRules.js";
import type { ResolvedEvidence } from "../src/catalog/evidenceGraph.js";
const signer = `did:demos:agent:${"a".repeat(64)}`;
const policy = (recipeVersion: number, defaultMaxAgeSec = 1): RecipePolicy => ({ scheme: "lei", recipeVersion,
  defaultMaxAgeSec, methods: ["verifiable-credential"], availability: "live", trustedResultSigners: [signer] });

test("session recipe pins resolve exact configured snapshots, never the unversioned policy list", async () => {
  const old = process.env.DACS_RECIPE_SNAPSHOTS;
  try {
    process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 4, recipes: [policy(1)] }, { registryVersion: 5, recipes: [policy(1), policy(2)] }]);
    assert.equal(await resolveConfiguredRecipeSnapshot(999), null);
    assert.deepEqual((await resolveConfiguredRecipeSnapshot(4))?.recipes, [policy(1)]);
    assert.deepEqual((await resolveConfiguredRecipeSnapshot(5))?.recipes, [policy(1), policy(2)]);
    process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 4, recipes: [policy(1), policy(1)] }]);
    assert.equal(await resolveConfiguredRecipeSnapshot(4), null);
  } finally { if (old === undefined) delete process.env.DACS_RECIPE_SNAPSHOTS; else process.env.DACS_RECIPE_SNAPSHOTS = old; }
});

test("loading a snapshot refuses self-signed for an authority-issued scheme and names the scheme", async () => {
  const old = process.env.DACS_RECIPE_SNAPSHOTS;
  try {
    process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 4, recipes: [policy(1)] },
      { registryVersion: 5, recipes: [policy(1), { ...policy(2), methods: ["self-signed"] }] }]);
    await assert.rejects(resolveConfiguredRecipeSnapshot(5), (error: unknown) => error instanceof SelfSignedAuthoritySchemeError &&
      error.message.includes("lei") && error.message.includes("self-signed"));
    assert.deepEqual((await resolveConfiguredRecipeSnapshot(4))?.recipes, [policy(1)], "a clean snapshot still loads");
    process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify([{ registryVersion: 6,
      recipes: [{ ...policy(1), scheme: "key", methods: ["self-signed"] }] }]);
    assert.equal((await resolveConfiguredRecipeSnapshot(6))?.recipes.length, 1, "self-signed for another scheme still loads");
  } finally { if (old === undefined) delete process.env.DACS_RECIPE_SNAPSHOTS; else process.env.DACS_RECIPE_SNAPSHOTS = old; }
});

test("snapshot membership, latest-at-start and freshness all use the selected recipe roster", async () => {
  const locator = `stor-${"a".repeat(40)}`; const contentHash = "b".repeat(64);
  const result: ResolvedEvidence = { kind: "verify-result", locator, contentHash,
    raw: { resultVersion: "1", reason: "registry response", fetchedAt: 19,
      attestation: { anchor: { kind: "storage-program", locator }, contentHash: "c".repeat(64) },
      scheme: "lei", identifier: "ABC", recipeVersion: 1, method: "verifiable-credential",
      signature: { signer, algorithm: "ed25519", value: Buffer.alloc(64).toString("base64url") },
      decision: "pass", verifiedAt: 20 } };
  const identity = { claims: [{ ref: "lei:ABC", verifiedBy: { anchor: { kind: "storage-program", locator }, contentHash, recipeVersion: 1 } }] };
  const check = (recipes: RecipePolicy[], required = { scheme: "lei", verificationRequired: true } as Record<string, unknown>, at = 30) =>
    matchesVetRequirement(identity, { requirementVersion: "1", required: [required] }, [result], at, at, recipes);
  assert.equal(await check([policy(1)]), true);
  assert.equal(await check([policy(2)]), false, "result absent from snapshot");
  assert.equal(await check([policy(1), policy(2)]), false, "unversioned requirement selects newer session-start recipe");
  assert.equal(await check([policy(1), policy(2)], { scheme: "lei", verificationRequired: true, recipeVersion: 1 }), true);
  assert.equal(await check([policy(1), policy(2)], { scheme: "lei", verificationRequired: true, recipeVersion: 2 }), false,
    "both versions exist, but the explicit requirement must match the result");
  assert.equal(await check([policy(1, 0)]), false, "snapshot default freshness cannot be replaced by another configured policy");
  assert.equal(await check([policy(1, 1)], { scheme: "lei", verificationRequired: true }, 1020), true);
  assert.equal(await check([policy(1, 1)], { scheme: "lei", verificationRequired: true }, 1021), false);
});

const otherSigner = `did:demos:agent:${"c".repeat(64)}`;

async function withSnapshotEnv(value: unknown, run: () => Promise<void>) {
  const old = process.env.DACS_RECIPE_SNAPSHOTS;
  try { process.env.DACS_RECIPE_SNAPSHOTS = JSON.stringify(value); await run(); }
  finally { if (old === undefined) delete process.env.DACS_RECIPE_SNAPSHOTS; else process.env.DACS_RECIPE_SNAPSHOTS = old; }
}

test("the trusted signer roster comes only from DACS_RECIPE_SNAPSHOTS", async () => {
  const locator = `stor-${"a".repeat(40)}`; const contentHash = "b".repeat(64);
  const resultSignedBy = (key: string, carried: Record<string, unknown>): ResolvedEvidence => ({ kind: "verify-result", locator, contentHash,
    raw: { resultVersion: "1", reason: "registry response", fetchedAt: 19,
      attestation: { anchor: { kind: "storage-program", locator }, contentHash: "c".repeat(64) },
      scheme: "lei", identifier: "ABC", recipeVersion: 1, method: "verifiable-credential",
      signature: { signer: key, algorithm: "ed25519", value: Buffer.alloc(64).toString("base64url") },
      decision: "pass", verifiedAt: 20, ...carried } });
  const identity = { claims: [{ ref: "lei:ABC", verifiedBy: { anchor: { kind: "storage-program", locator }, contentHash, recipeVersion: 1 } }] };
  const carriedRosters = { trustedResultSigners: [otherSigner], recipe: { ...policy(1), trustedResultSigners: [otherSigner] } };
  await withSnapshotEnv([{ registryVersion: 4, recipes: [policy(1)], trustedResultSigners: [otherSigner] }], async () => {
    const roster = (await resolveConfiguredRecipeSnapshot(4))?.recipes ?? [];
    const check = (result: ResolvedEvidence, requirement: Record<string, unknown> = {}) =>
      matchesVetRequirement(identity, { requirementVersion: "1", required: [{ scheme: "lei", verificationRequired: true, ...requirement }] },
        [result], 30, 30, roster);
    assert.equal(await check(resultSignedBy(signer, {})), true, "a key in the env roster is accepted");
    assert.equal(await check(resultSignedBy(otherSigner, {})), false, "a key outside the env roster is refused");
    assert.equal(await check(resultSignedBy(otherSigner, carriedRosters)), false, "a result carrying its own signer list adds nothing");
    assert.equal(await check(resultSignedBy(otherSigner, {}), carriedRosters), false, "a request field carrying a signer list adds nothing");
    assert.equal(await check({ ...resultSignedBy(otherSigner, {}), ...carriedRosters }), false, "a fetched document carrying a signer list adds nothing");
  });
});

test("resolving snapshots logs one line with the source and counts, and no key material", async () => {
  const info = mock.method(console, "info", () => undefined);
  try {
    await withSnapshotEnv([{ registryVersion: 7, recipes: [policy(1), { ...policy(2), trustedResultSigners: [signer, otherSigner] }] },
      { registryVersion: 8, recipes: [policy(1)] }], async () => {
      await resolveConfiguredRecipeSnapshot(7);
      await resolveConfiguredRecipeSnapshot(8);
    });
    assert.deepEqual(info.mock.calls.map((call) => call.arguments), [["DACS_RECIPE_SNAPSHOTS: 2 snapshots, 2 trusted signers"]]);
    const line = String(info.mock.calls[0].arguments[0]);
    assert.ok(!line.includes("did:demos") && !line.includes("a".repeat(64)) && !line.includes("lei"), "no signer key or snapshot content");
  } finally { info.mock.restore(); }
});

test("the snapshot docs call the configuration operator-trusted and unauthenticated", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const pin = readFileSync(new URL("../SPEC_PIN", import.meta.url), "utf8");
  const source = readFileSync(new URL("../src/catalog/recipePolicy.ts", import.meta.url), "utf8");
  const snapshotRow = readme.split("\n").find((line) => line.includes("`DACS_RECIPE_SNAPSHOTS`")) ?? "";
  for (const text of [snapshotRow, pin, source]) {
    assert.doesNotMatch(text, /operator-authenticated/i);
    assert.match(text, /operator-trusted/);
    assert.match(text, /unauthenticated/);
  }
});
