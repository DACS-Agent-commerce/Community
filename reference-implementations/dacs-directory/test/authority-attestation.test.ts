import assert from "node:assert/strict";
import { relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { authenticateAuthorityAttestation, AUTHORITY_VERIFY_TIMEOUT_MS } from "../src/catalog/authorityAttestation.js";
import { AUTHORITY_VERIFIER_ENV, AuthorityVerifierUnavailable, loadAuthorityVerifier } from "../src/catalog/authorityVerifierConfig.js";
import { authorityProof, authoritySigner, proofHash, verifyTestAuthority } from "./helpers/authority.js";

const verifierModule = (name: string) => new URL(`./fixtures/authority-verifier/${name}.ts`, import.meta.url);

test("DACS_AUTHORITY_VERIFIER names the deployment's verifier module; unset or none configures no verifier", async () => {
  const load = (value?: string) => loadAuthorityVerifier(value === undefined ? {} : { [AUTHORITY_VERIFIER_ENV]: value });
  assert.deepEqual(await load(), { id: null, optedOut: false }, "unset: none, the shipped default");
  assert.deepEqual(await load(" "), { id: null, optedOut: false });
  assert.deepEqual(await load("none"), { id: null, optedOut: true }, "none: deliberately none");
  const { href } = verifierModule("accepts");
  for (const value of [href, fileURLToPath(href), ` ${fileURLToPath(href)} `, relative(process.cwd(), fileURLToPath(href))]) {
    assert.deepEqual(await load(value), { id: href, optedOut: false, verify: verifyTestAuthority }, value);
  }
  const prior = process.env[AUTHORITY_VERIFIER_ENV];
  process.env[AUTHORITY_VERIFIER_ENV] = href;
  try {
    assert.equal((await loadAuthorityVerifier()).verify, verifyTestAuthority, "the default reads the process environment");
  } finally {
    if (prior === undefined) delete process.env[AUTHORITY_VERIFIER_ENV]; else process.env[AUTHORITY_VERIFIER_ENV] = prior;
  }
});

test("a configured verifier that cannot be used is refused with its cause, never read as no verifier", async () => {
  const refused = async (value: string, pattern: RegExp, cause?: (cause: unknown) => boolean) => {
    const error = await loadAuthorityVerifier({ [AUTHORITY_VERIFIER_ENV]: value }).then(() => null, (e: unknown) => e);
    assert.ok(error instanceof AuthorityVerifierUnavailable, value);
    assert.equal(error.code, "AUTHORITY_VERIFIER_UNAVAILABLE");
    assert.match(error.message, pattern, value);
    assert.equal(cause ? cause(error.cause) : error.cause === undefined, true, `${value}: ${String(error.cause)}`);
  };
  const code = (want: string) => (cause: unknown) => (cause as { code?: unknown } | undefined)?.code === want;
  await refused(fileURLToPath(verifierModule("missing")), /could not be loaded/, code("ERR_MODULE_NOT_FOUND"));
  await refused(verifierModule("throws").href, /could not be loaded: fixture verifier has no roster configured/,
    (cause) => cause instanceof Error && cause.message === "fixture verifier has no roster configured");
  await refused(verifierModule("no-export").href, /exports no verifyAuthorityAttestation function/);
  await refused(verifierModule("not-a-function").href, /exports no verifyAuthorityAttestation function/);
  // Only local files load: remote and inline code are read as (missing) paths.
  for (const value of ["https://verifier.example/verify.mjs", "data:text/javascript,export const verifyAuthorityAttestation = async () => true"]) {
    await refused(value, /could not be loaded/, code("ERR_MODULE_NOT_FOUND"));
  }
});

test("authority authentication fails without an adapter and on adapter failure or exception", async () => {
  const raw = authorityProof({ subject: "lei:ABC", status: "active" });
  const ref = { signer: authoritySigner, contentHash: proofHash(raw) };
  const result = { method: "verifiable-credential" };
  assert.equal(await authenticateAuthorityAttestation(raw, ref, result), false);
  assert.equal(await authenticateAuthorityAttestation(raw, ref, result, async () => false), false);
  assert.equal(await authenticateAuthorityAttestation(raw, ref, result, async () => { throw new Error("unavailable"); }), false);
  assert.equal(await authenticateAuthorityAttestation(raw, ref, {}, verifyTestAuthority), false);
  assert.equal(await authenticateAuthorityAttestation(raw, ref, result, verifyTestAuthority), true);
});

test("an adapter that has not answered by the deadline has not authenticated the proof", async () => {
  assert.equal(AUTHORITY_VERIFY_TIMEOUT_MS, 30_000);
  const raw = authorityProof({ subject: "lei:ABC", status: "active" });
  const ref = { signer: authoritySigner, contentHash: proofHash(raw) };
  const result = { method: "verifiable-credential" };
  const check = (verify: Parameters<typeof authenticateAuthorityAttestation>[3]) => authenticateAuthorityAttestation(raw, ref, result, verify, 20);
  const started = Date.now();
  assert.equal(await check(() => new Promise<boolean>(() => {})), false, "a stalled adapter");
  assert.ok(Date.now() - started < 5_000);
  assert.equal(await check(() => new Promise<boolean>((resolve) => setTimeout(resolve, 200, true))), false, "a late yes");
  // A late failure is absorbed: an unhandled rejection would fail this file.
  assert.equal(await check(() => new Promise<boolean>((_, reject) => setTimeout(reject, 50, new Error("late")))), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(await check(verifyTestAuthority), true, "an adapter that answers in time");
});

test("the proof's content hash is checked before the adapter, so an accepting adapter cannot bypass it (DACS-2 §7.5.2 step 2)", async () => {
  const raw = authorityProof({ subject: "lei:ABC", status: "active" });
  const result = { method: "verifiable-credential" };
  const accept = async () => true;
  const check = (contentHash: unknown, value: Record<string, unknown> = raw) =>
    authenticateAuthorityAttestation(value, { signer: authoritySigner, contentHash }, result, accept);
  assert.equal(await check(proofHash(raw)), true);
  assert.equal(await check(`sha256:${proofHash(raw).toUpperCase()}`), true, "the hash forms a VerifyResultRef accepts");
  assert.equal(await check(`sha256-${proofHash(raw)}`), true);
  for (const contentHash of ["0".repeat(64), proofHash({ ...raw, status: "revoked" }), "", 7, undefined]) {
    assert.equal(await check(contentHash), false, String(contentHash));
  }
  assert.equal(await check(proofHash(raw), { ...raw, status: "revoked" }), false, "changed content");
  assert.equal(await check(proofHash(raw), { ...raw, signature: "A".repeat(86) }), false, "the hash covers the proof's signature fields");
});

test("authority adapter authenticates original proof bytes, required signer and validator epoch", async () => {
  for (const field of ["signature", "proofSignature"]) {
    const raw = authorityProof({ subject: "lei:ABC", status: "active" }, 7, field);
    const ref = { signer: authoritySigner, contentHash: proofHash(raw) };
    const result = { method: "consensus-backed-proxy" };
    const check = (value = raw, reference = ref) => authenticateAuthorityAttestation(value, reference, result, verifyTestAuthority);
    assert.equal(await check(), true);
    const alteredProof = { ...raw, [field]: "A".repeat(86) };
    assert.equal(await check(alteredProof), false, "original hash scope includes proof");
    assert.equal(await check(alteredProof, { ...ref, contentHash: proofHash(alteredProof) }), false, "matching hash cannot replace a signature");
    const changedSigner = { ...raw, signer: `did:demos:agent:${"b".repeat(64)}` };
    assert.equal(await check(changedSigner, { ...ref, contentHash: proofHash(changedSigner) }), false);
    assert.equal(await check(raw, { ...ref, signer: changedSigner.signer }), false);
    const wrongEpoch = authorityProof({ subject: "lei:ABC", status: "active" }, 8, field);
    assert.equal(await check(wrongEpoch, { ...ref, contentHash: proofHash(wrongEpoch) }), false, "even correctly signed proof requires the trusted epoch");
    const changedBody = { ...raw, status: "revoked" };
    assert.equal(await check(changedBody, { ...ref, contentHash: proofHash(changedBody) }), false);
    assert.equal(await authenticateAuthorityAttestation({ ...raw, nested: ["\ud800"] }, ref, result, async () => true), false);
  }
});
