import assert from "node:assert/strict";
import test from "node:test";
import { authenticateAuthorityAttestation } from "../src/catalog/authorityAttestation.js";
import { authorityProof, authoritySigner, proofHash, verifyTestAuthority } from "./helpers/authority.js";

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
