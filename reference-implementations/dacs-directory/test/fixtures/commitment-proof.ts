import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, ed25519Verify, privateKeyFromSeed, publicKeyFromSeed } from "@kynesyslabs/dacs/crypto";
import { buildCurrentEvidenceGraph, artifactHash, type EvidenceGraphDeps } from "../../src/catalog/evidenceGraph.js";
import { indexRegistration } from "../../src/catalog/indexer.js";
import { legacyListingHash } from "../../src/catalog/legacyListingHash.js";
import type { CommitmentProof, CommitmentVerifier } from "../../src/catalog/commitmentFinality.js";
import { dids, locator, maps, seeds, type Obj } from "./current-evidence.js";

const authoritySeed = Uint8Array.from(Buffer.alloc(32, 71));
const signedValue = (message: string, seed: Uint8Array) =>
  Buffer.from(ed25519Sign(Buffer.from(message), privateKeyFromSeed(seed))).toString("base64url");

/** Independent fixture finality authority, pinned out of band; never a Demos profile. */
export function signReceipt(proof: CommitmentProof): void {
  const { evidence: _evidence, ...scope } = proof.receipt;
  proof.receipt.evidence = { kind: "fixture-finality", value: signedValue(contentHash(scope), authoritySeed) };
}

export function signCommitment(proof: CommitmentProof, authority = { claim: dids[0], seed: seeds[0] }): void {
  const { signature: _signature, ...scope } = proof.record;
  const legacy = scope.dacsVersion === "1";
  const signature = { algorithm: "ed25519" as const, signer: authority.claim,
    value: signedValue(`${legacy ? "dacs-commitment:v1:" : "dacs-finality-commitment:v1:"}${contentHash(scope)}`, authority.seed) };
  if (legacy) proof.legacySignature = signature;
  else proof.record.signature = signature;
  proof.receipt.contentHash = contentHash(proof.record);
  signReceipt(proof);
}

export function commitmentProof(agreement: Obj, listingRef: Obj, committedAt = 90, legacy = false, authority = { claim: dids[0], seed: seeds[0] }, signingParties: readonly string[] = [dids[0], dids[1]]): CommitmentProof {
  const current = agreement.agreementVersion === "1" || agreement.payeeBoundAgreementVersion === "1";
  const { signatures: _signatures, ...agreementScope } = agreement;
  const parties = current && Array.isArray(agreement.parties)
    ? [...signingParties] : [agreement.buyer, agreement.seller];
  const record: Obj = { jobId: agreement.jobId, agreementHash: current ? artifactHash(agreement, "agreement") : legacyListingHash(agreementScope),
    listingRef, parties, pattern: agreement.derivedFromPattern ?? agreement.pattern,
    ...(legacy ? { dacsVersion: "1", committedAt } : { finalityCommitmentVersion: "1", createdAt: 1 }) };
  const proof: CommitmentProof = { record, orchestrator: authority.claim, nativeAddress: locator(7000), receipt: {
    receiptVersion: "1", substrate: "fixture:test", finalityProfile: "fixture-quorum", logicalAddress: `dacs3:commit:${agreement.jobId}`,
    nativeAddress: locator(7000), contentHash: "0".repeat(64), writer: "fixture-relayer", nonce: "5",
    transactionRef: { kind: "fixture-tx", value: "commitment-transaction" }, state: "finalized", observationDisposition: "established",
    observedAt: 150, blockRef: { id: "fixture-block", height: "1", timestamp: committedAt }, evidence: { kind: "fixture-finality", value: "" },
  } };
  signCommitment(proof, authority);
  return proof;
}

export const fixtureCommitments: CommitmentVerifier = {
  resolve: async (context) => {
    // Exact authenticated context keys, independent buyer/seller roster; no first-match job lookup.
    const key = (p: CommitmentProof["record"]) => canonicalize([p.jobId, p.agreementHash, p.listingRef, p.pattern]);
    const proofs = new Map<string, CommitmentProof>();
    for (const agreement of maps.values()) {
      if (agreement.agreementVersion !== "1" && agreement.payeeBoundAgreementVersion !== "1" && typeof agreement.pattern !== "string") continue;
      const pin = agreement.agreementVersion === "1" || agreement.payeeBoundAgreementVersion === "1"
        ? agreement.listingRef : context.listingRef;
      if (!pin || typeof pin !== "object" || Array.isArray(pin)) continue;
      const proof = commitmentProof(agreement, pin as Obj);
      proofs.set(key(proof.record), proof);
    }
    return proofs.get(canonicalize([context.jobId, context.agreementHash, context.listingRef, context.pattern])) ?? null;
  },
  verifyReceipt: async (receipt) => {
    const { evidence, ...scope } = receipt;
    return receipt.substrate === "fixture:test" && receipt.finalityProfile === "fixture-quorum" &&
      evidence.kind === "fixture-finality" && await ed25519Verify(Buffer.from(contentHash(scope)),
        Buffer.from(evidence.value, "base64url"), publicKeyFromSeed(authoritySeed));
  },
};

/** Supply explicit test proof policy to existing graph fixtures. */
export function graphWithCommitments(at: string, deps: EvidenceGraphDeps) {
  return buildCurrentEvidenceGraph(at, { ...deps, commitment: fixtureCommitments });
}

/** Supply explicit test proof policy without enabling it in production callers. */
export function indexWithCommitments(...args: Parameters<typeof indexRegistration>) {
  const [registration, prior, identities, recipes, omitted, legacy] = args;
  return indexRegistration(registration, prior, identities, recipes, omitted, legacy, fixtureCommitments);
}
