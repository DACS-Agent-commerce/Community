import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { ANCHOR_BINDING_DOMAIN, deliverableLogicalAddress, paymentLogicalAddress } from "../../src/catalog/anchorBinding.js";

type Obj = Record<string, unknown>;

/** A test StorageProgram name that carries no logical address: bindings, never names, resolve anchors. */
export const OPAQUE_PROGRAM_NAME = "opaque-write-input";

const signerOf = (seed: Uint8Array) => `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;

/** Sign an AnchorBinding as the party holding `seed`; `edit` changes the scope before signing. */
export async function signAnchorBinding(
  seed: Uint8Array,
  scope: { jobId: string; logicalAddress: string; nativeAddress: string; contentHash: string },
  edit?: (scope: Obj) => void,
): Promise<Obj> {
  const body: Obj = { anchorBindingVersion: "1", ...scope, signer: signerOf(seed) };
  edit?.(body);
  const value = Buffer.from(await ed25519Sign(
    Buffer.from(ANCHOR_BINDING_DOMAIN + contentHash(body), "utf8"),
    privateKeyFromSeed(seed),
  )).toString("base64url");
  return { ...body, signature: { algorithm: "ed25519", signer: body.signer, value } };
}

/** The PC-2 binding for payment evidence anchored at `nativeAddress` with AttestationRef hash `hash`. */
export const paymentAnchorBinding = (seed: Uint8Array, jobId: string, railId: string, phaseIndex: number, nativeAddress: string, hash: string) =>
  signAnchorBinding(seed, { jobId, logicalAddress: paymentLogicalAddress(jobId, railId, phaseIndex), nativeAddress, contentHash: hash });

/** The §9.6.1 binding for a storage deliverable whose DV-1 cleartext hash is `hash`. */
export const deliverableAnchorBinding = (seed: Uint8Array, jobId: string, nativeAddress: string, hash: string) =>
  signAnchorBinding(seed, { jobId, logicalAddress: deliverableLogicalAddress(jobId), nativeAddress, contentHash: hash });
