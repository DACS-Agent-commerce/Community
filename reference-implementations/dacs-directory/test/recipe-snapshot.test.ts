import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguredRecipeSnapshot, type RecipePolicy } from "../src/catalog/recipePolicy.js";
import { matchesVetRequirement } from "../src/catalog/vetClaimRules.js";
import type { ResolvedEvidence } from "../src/catalog/evidenceGraph.js";
const policy = (recipeVersion: number, defaultMaxAgeSec = 1): RecipePolicy => ({ scheme: "lei", recipeVersion,
  defaultMaxAgeSec, methods: ["verifiable-credential"], availability: "live", trustedResultSigners: [] });

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

test("snapshot membership, latest-at-start and freshness all use the selected recipe roster", () => {
  const locator = `stor-${"a".repeat(40)}`; const contentHash = "b".repeat(64);
  const result: ResolvedEvidence = { kind: "verify-result", locator, contentHash,
    raw: { scheme: "lei", identifier: "ABC", recipeVersion: 1, decision: "pass", verifiedAt: 20 } };
  const identity = { claims: [{ ref: "lei:ABC", verifiedBy: { anchor: { kind: "storage-program", locator }, contentHash, recipeVersion: 1 } }] };
  const check = (recipes: RecipePolicy[], required = { scheme: "lei" } as Record<string, unknown>, at = 30) =>
    matchesVetRequirement(identity, { required: [required] }, [result], at, at, recipes);
  assert.equal(check([policy(1)]), true);
  assert.equal(check([policy(2)]), false, "result absent from snapshot");
  assert.equal(check([policy(1), policy(2)]), false, "unversioned requirement selects newer session-start recipe");
  assert.equal(check([policy(1), policy(2)], { scheme: "lei", recipeVersion: 1 }), true);
  assert.equal(check([policy(1, 0)]), false, "snapshot default freshness cannot be replaced by another configured policy");
  assert.equal(check([policy(1, 1)], { scheme: "lei" }, 1020), true);
  assert.equal(check([policy(1, 1)], { scheme: "lei" }, 1021), false);
});
