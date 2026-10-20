import "./helpers/isolated-directory.js";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AUTHORITY_VERIFIER_ENV } from "../src/catalog/authorityVerifierConfig.js";
import { counterpartyEvidenceSellerRecord } from "../src/catalog/counterpartyEvidence.js";
import { loadCatalog, saveCatalog } from "../src/catalog/store.js";

// The reindex CLI and the Next server are separate processes (scripts/start-railway.sh): each must resolve
// DACS_AUTHORITY_VERIFIER itself, and one without a usable verifier must not rewrite the tiers.
const appDir = fileURLToPath(new URL("..", import.meta.url));
const accepting = new URL("./fixtures/authority-verifier/accepts.ts", import.meta.url).href;
const run = promisify(execFile);

/** Runs `script` as its own process in this test's data directory, with only `verifier` configured. */
async function processWith(script: string, verifier: string | undefined) {
  // An unreachable node: a pass that got past its verifier checks fails at its first read.
  const env: NodeJS.ProcessEnv = { ...process.env, DEMOS_RPC: "http://127.0.0.1:9" };
  delete env[AUTHORITY_VERIFIER_ENV];
  if (verifier !== undefined) env[AUTHORITY_VERIFIER_ENV] = verifier;
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", script], { cwd: appDir, env, timeout: 60_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

test("separate processes resolve the same DACS_AUTHORITY_VERIFIER to the same verifier", async () => {
  const resolved = async (verifier: string | undefined) =>
    JSON.parse((await processWith("test/fixtures/authority-verifier/print-config.ts", verifier)).stdout) as Record<string, unknown>;
  const relativePath = "test/fixtures/authority-verifier/accepts.ts";
  for (const verifier of [accepting, relativePath, fileURLToPath(accepting)]) {
    assert.deepEqual(await resolved(verifier), { id: accepting, optedOut: false, verify: "function" }, verifier);
  }
  assert.deepEqual(await resolved(undefined), { id: null, optedOut: false, verify: "undefined" });
  assert.deepEqual(await resolved("none"), { id: null, optedOut: true, verify: "undefined" });
  assert.match(String((await resolved("test/fixtures/authority-verifier/missing.ts")).error),
    /^AuthorityVerifierUnavailable: DACS_AUTHORITY_VERIFIER file:.*missing\.ts could not be loaded/);
});

test("a reindex CLI process without the catalog's verifier, or with one that cannot load, exits before any write", async () => {
  // The server process derived these tiers with the accepting verifier.
  const seller = { ...counterpartyEvidenceSellerRecord(1), identityTier: "institutional" as const };
  saveCatalog({ catalogVersion: "1", generatedAt: 1, sellers: [seller], identityTierVerifier: accepting });
  const saved = loadCatalog();
  for (const [verifier, reason] of [
    [undefined, /reindex failed: the catalog's identity tiers were derived with file:.*accepts\.ts, and DACS_AUTHORITY_VERIFIER is unset/],
    ["test/fixtures/authority-verifier/missing.ts", /reindex failed: DACS_AUTHORITY_VERIFIER file:.*missing\.ts could not be loaded/],
    [new URL("./fixtures/authority-verifier/throws.ts", import.meta.url).href, /could not be loaded: fixture verifier has no roster configured/],
  ] as const) {
    const cli = await processWith("src/catalog/reindex.ts", verifier);
    assert.equal(cli.code, 1, String(verifier));
    assert.match(cli.stderr, reason, String(verifier));
    assert.deepEqual(loadCatalog(), saved, `${verifier}: the institutional tier and its verifier are kept`);
  }
});
