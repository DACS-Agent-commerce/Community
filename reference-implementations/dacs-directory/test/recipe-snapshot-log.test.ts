import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolveConfiguredRecipeSnapshot, SelfSignedAuthoritySchemeError, type RecipePolicy } from "../src/catalog/recipePolicy.js";

const recipe = (signers: string[] = []): RecipePolicy => ({ scheme: "key", recipeVersion: 1, methods: ["self-signed"],
  availability: "live", defaultMaxAgeSec: 60, trustedResultSigners: signers });
const snapshot = (registryVersion: number, recipes: RecipePolicy[] = []) => ({ registryVersion, recipes });

function observe(t: TestContext) {
  const previous = process.env.DACS_RECIPE_SNAPSHOTS;
  t.after(() => {
    if (previous === undefined) delete process.env.DACS_RECIPE_SNAPSHOTS;
    else process.env.DACS_RECIPE_SNAPSHOTS = previous;
  });
  const lines: string[] = [];
  t.mock.method(console, "info", (line: unknown) => { lines.push(String(line)); });
  return { lines, async resolve(text: string | undefined, version: number) {
    if (text === undefined) delete process.env.DACS_RECIPE_SNAPSHOTS;
    else process.env.DACS_RECIPE_SNAPSHOTS = text;
    return resolveConfiguredRecipeSnapshot(version);
  } };
}

test("snapshot logging deduplicates A -> B -> A while every lookup still resolves fresh data", async (t) => {
  const { lines, resolve } = observe(t);
  const a = snapshot(26601, [recipe(["synthetic-signer-a", "synthetic-signer-b", "synthetic-signer-a"])]);
  const b = [snapshot(26602, [recipe(["synthetic-signer-c"])]), snapshot(26603)];
  const A = JSON.stringify([a]); const B = JSON.stringify(b);
  const first = await resolve(A, 26601);
  assert.deepEqual(first, a);
  first!.recipes[0].trustedResultSigners.push("caller-only-mutation");
  assert.deepEqual(await resolve(A, 26601), a, "the log cache must not cache or mutate resolved policy data");
  assert.deepEqual(await resolve(B, 26602), b[0]);
  assert.deepEqual(await resolve(A, 26601), a, "A still resolves after B without logging again");
  assert.deepEqual(lines, ["DACS_RECIPE_SNAPSHOTS: 1 snapshots, 2 trusted signers",
    "DACS_RECIPE_SNAPSHOTS: 2 snapshots, 1 trusted signers"]);
  assert.ok(lines.every((line) => !line.includes("synthetic-signer") && !line.includes("caller-only")));
});

test("unparsable text logs once even after another configuration and then recovers", async (t) => {
  const { lines, resolve } = observe(t);
  const bad = '{"synthetic-private-marker-266":';
  const good = snapshot(26610);
  assert.equal(await resolve(bad, 26610), null);
  assert.equal(await resolve(bad, 26610), null);
  assert.deepEqual(await resolve(JSON.stringify([good]), 26610), good);
  assert.equal(await resolve(bad, 26610), null);
  assert.deepEqual(lines, ["DACS_RECIPE_SNAPSHOTS: unparsable value; no snapshots loaded",
    "DACS_RECIPE_SNAPSHOTS: 1 snapshots, 0 trusted signers"]);
  assert.ok(lines.every((line) => !line.includes("synthetic-private-marker")));
});

test("empty, whitespace and malformed JSON each produce one generic note without their contents", async (t) => {
  const { lines, resolve } = observe(t);
  const texts = ["", " ", "[", "{bad-266", '{"do-not-log-266":'];
  for (const text of texts) {
    assert.equal(await resolve(text, 26620), null);
    assert.equal(await resolve(text, 26620), null);
  }
  assert.deepEqual(lines, texts.map(() => "DACS_RECIPE_SNAPSHOTS: unparsable value; no snapshots loaded"));
});

test("valid JSON that is not a snapshot array stays null and logs a distinct shape note once", async (t) => {
  const { lines, resolve } = observe(t);
  const texts = ["null", "{}", "true", "false", "7", '"not-a-list-266"', '{"do-not-log-266":"value"}'];
  for (const text of texts) {
    assert.equal(await resolve(text, 26630), null);
    assert.equal(await resolve(text, 26630), null);
  }
  assert.deepEqual(lines, texts.map(() => "DACS_RECIPE_SNAPSHOTS: not a snapshot array; no snapshots loaded"));
});

test("absent configuration stays silent while an explicit empty array is summarized", async (t) => {
  const { lines, resolve } = observe(t);
  assert.equal(await resolve(undefined, 26635), null);
  assert.deepEqual(lines, []);
  assert.equal(await resolve("[]", 26635), null);
  assert.equal(await resolve(undefined, 26635), null);
  assert.equal(await resolve("[]", 26635), null);
  assert.equal(await resolve("[ ]", 26635), null);
  assert.equal(await resolve(undefined, 26635), null);
  assert.deepEqual(lines, ["DACS_RECIPE_SNAPSHOTS: 0 snapshots, 0 trusted signers",
    "DACS_RECIPE_SNAPSHOTS: 0 snapshots, 0 trusted signers"]);
});

test("suppressing repeated log lines never suppresses authority-scheme refusal or clean snapshot resolution", async (t) => {
  const { lines, resolve } = observe(t);
  const refused = snapshot(26640, [{ ...recipe(), scheme: "lei" }]);
  const clean = snapshot(26641);
  const text = JSON.stringify([refused, clean]);
  await assert.rejects(resolve(text, 26640), SelfSignedAuthoritySchemeError);
  await assert.rejects(resolve(text, 26640), SelfSignedAuthoritySchemeError);
  assert.deepEqual(await resolve(text, 26641), clean);
  assert.deepEqual(await resolve(text, 26641), clean);
  assert.equal(await resolve(text, 26642), null);
  assert.deepEqual(lines, ["DACS_RECIPE_SNAPSHOTS: 2 snapshots, 0 trusted signers"]);
});

test("distinct raw texts with equivalent JSON each log once", async (t) => {
  const { lines, resolve } = observe(t);
  const value = [snapshot(26650)];
  const compact = JSON.stringify(value); const spaced = JSON.stringify(value, null, 2);
  for (const text of [compact, spaced, compact, spaced]) assert.deepEqual(await resolve(text, 26650), value[0]);
  assert.deepEqual(lines, ["DACS_RECIPE_SNAPSHOTS: 1 snapshots, 0 trusted signers",
    "DACS_RECIPE_SNAPSHOTS: 1 snapshots, 0 trusted signers"]);
});
