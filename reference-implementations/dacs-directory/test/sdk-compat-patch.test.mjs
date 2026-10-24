import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const patchPath = fileURLToPath(new URL("../scripts/dacs-sdk-compat.patch", import.meta.url));
const setupScript = readFileSync(new URL("../scripts/setup-sdk.sh", import.meta.url), "utf8");
const patchLines = readFileSync(patchPath, "utf8").split("\n");
const HUNK_BREAK = "\u0000hunk-break";

/** The patched file text of every hunk (context and added lines), hunks separated by a break marker. */
const patchedLines = patchLines.flatMap((line) => {
  if (line.startsWith("@@")) return [HUNK_BREAK];
  if (line.startsWith("+++") || line.startsWith("---")) return [];
  return line.startsWith("+") || line.startsWith(" ") ? [line.slice(1)] : [];
});

/** Patched lines from the first one containing `start` up to (excluding) the next one equal to `end`, within one hunk. */
function patchedSection(start, end) {
  const first = patchedLines.findIndex((line) => line.includes(start));
  assert.notEqual(first, -1, `patch no longer contains ${start}`);
  const last = patchedLines.findIndex((line, index) => index > first && line === end);
  assert.notEqual(last, -1, `patch no longer contains ${end} after ${start}`);
  const section = patchedLines.slice(first, last);
  assert.ok(!section.includes(HUNK_BREAK), `${start} section spans two hunks`);
  return section.join("\n");
}

/** Compile TypeScript patch text into a function of `parameters`; the text is the function body. */
function compile(parameters, body) {
  const source = stripTypeScriptTypes(`async function compiled(${parameters.join(", ")}) {\n${body}\n}`);
  return new Function(`${source}\nreturn compiled;`)();
}

const signatureBytes = Buffer.alloc(64, 7);
const base64url = signatureBytes.toString("base64url");
const hex = signatureBytes.toString("hex");
const base64urlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// The final character carries 4 unused bits; the next alphabet character decodes to the same 64 bytes.
const trailingBitsAlias = base64url.slice(0, 85) + base64urlAlphabet[base64urlAlphabet.indexOf(base64url[85]) + 1];

const legacySignatureSource = `${patchedSection("function legacySignatureValue(", "}")}\n}`;
const legacySignatureValue = compile(["value"], `${legacySignatureSource}\nreturn legacySignatureValue(value);`);

test("legacy signature decoding accepts only 128 hex digits with one optional 0x, or canonical Base64URL of 64 bytes", async () => {
  for (const accepted of [hex, `0x${hex}`, hex.toUpperCase(), base64url]) {
    assert.equal(await legacySignatureValue(accepted), base64url, accepted);
  }
  assert.deepEqual(Buffer.from(trailingBitsAlias, "base64url"), signatureBytes);
  for (const refused of [
    `${base64url}!!`, `${base64url}!`, `${base64url.slice(0, 40)}\n${base64url.slice(40)}`, `${base64url}=`,
    trailingBitsAlias, signatureBytes.toString("base64"), `0x0x${hex}`, `0X0x${hex}`, ` ${hex}`, hex.slice(2), `${hex}00`,
    Buffer.alloc(63, 7).toString("base64url"), Buffer.alloc(65, 7).toString("base64url"), "", 7, null, undefined, {},
  ]) {
    assert.equal(await legacySignatureValue(refused), null, String(refused));
  }
});

// The checks of authenticateLegacyListingReference that run before the key is resolved, with stand-in helpers.
const checkLegacyListingSignature = compile(
  ["artifact", "signer"],
  `${legacySignatureSource}\nconst sameCanonicalClaimIdentity = (a, b) => a === b;\n`
  + `${patchedSection('if (!Object.prototype.hasOwnProperty.call(artifact, "signature"))', "  let key: Uint8Array | null;")}\n`
  + 'return { verdict: "key-resolution-reached" };',
);

const seller = "did:demos:agent:seller";
const signedBySeller = { algorithm: "ed25519", signer: seller, value: hex };

test("legacy Listing signatures with no resolvable publisher stay unresolved, not malformed", async () => {
  const unresolved = { verdict: "unresolved", reason: "legacy-signer-unresolved" };
  assert.deepEqual(await checkLegacyListingSignature({ signature: hex }, null), unresolved);
  assert.deepEqual(await checkLegacyListingSignature({ signature: signedBySeller }, null), unresolved);
});

test("legacy Listing signatures with a malformed spelling or another signer are malformed", async () => {
  const malformed = { verdict: "malformed", reason: "invalid-legacy-listing-signature" };
  for (const signature of [
    `${base64url}!`, { ...signedBySeller, algorithm: "rsa" }, { ...signedBySeller, signer: "did:demos:agent:other" },
    { ...signedBySeller, signer: 1 }, null,
  ]) {
    assert.deepEqual(await checkLegacyListingSignature({ signature }, seller), malformed);
  }
  assert.deepEqual(await checkLegacyListingSignature({}, seller), { verdict: "missing" });
  assert.deepEqual(await checkLegacyListingSignature({ signature: signedBySeller }, seller), { verdict: "key-resolution-reached" });
});

// The condition that sends a settlement evidence reference to the historical authenticator, with stand-in shape checks:
// the historical evidence shape carries phaseIndex, the current one refuses it.
const usesHistoricalEvidenceAuthenticator = compile(
  ["evidence", "ev", "isNormativeGraph", "isLegacyMvpGraph"],
  "const isLegacyMvpAttestationRef = (ref) => ref.kind !== undefined;\n"
  + "const isLegacyMvpSettlementEvidence = (value) => value.phaseIndex !== undefined;\n"
  + `return ${patchedLines.find((line) => line.includes("isLegacyMvpAttestationRef(ev)") && line.trimStart().startsWith("if (")).trim().slice("if (".length, -") {".length)};`,
);

test("only historical-shaped evidence behind a historical reference skips the semantic evidence verifier", async () => {
  const historicalRef = { kind: "dacs-4-evidence", id: "evidence", contentHash: "a".repeat(64) };
  const ok = { check: { verdict: "ok" } };
  const historical = { ...ok, value: { evidenceVersion: "1", phaseIndex: 0 } };
  const currentShaped = { ...ok, value: { evidenceVersion: "1" } };
  assert.equal(await usesHistoricalEvidenceAuthenticator(historical, historicalRef, false, true), true);
  assert.equal(await usesHistoricalEvidenceAuthenticator(currentShaped, historicalRef, false, true), false);
});

test("the compatibility patch applies at its recorded base revision", (context) => {
  const baseRevision = (setupScript.match(/^SDK_PATCH_BASE_REV="([0-9a-f]{40})"$/m) ?? setupScript.match(/^SDK_REV="([0-9a-f]{40})"$/m))?.[1];
  assert.ok(baseRevision);
  const checkout = fileURLToPath(new URL("../vendor/dacs-sdk", import.meta.url));
  const files = patchLines.filter((line) => line.startsWith("+++ b/")).map((line) => line.slice("+++ b/".length));
  const sources = files.map((file) => spawnSync("git", ["-C", checkout, "show", `${baseRevision}:${file}`], { encoding: "utf8" }));
  if (sources.some((source) => source.status !== 0)) return context.skip("no vendored SDK checkout contains the patch base revision");
  const scratch = mkdtempSync(join(tmpdir(), "dacs-compat-patch-"));
  try {
    files.forEach((file, index) => {
      mkdirSync(dirname(join(scratch, file)), { recursive: true });
      writeFileSync(join(scratch, file), sources[index].stdout);
    });
    const run = spawnSync("git", ["apply", "--check", patchPath], { cwd: scratch, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
