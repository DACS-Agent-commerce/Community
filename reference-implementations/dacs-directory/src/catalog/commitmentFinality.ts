import { encodeAddressSegment } from "@kynesyslabs/dacs/canonical";
import { isCommitmentRecord, isReadableFinalityCommitmentRecord, isReadableAnchorReceipt, isComponentSignature,
  type AnchorReceipt, type ComponentSignature } from "@kynesyslabs/dacs/artifacts";
import { boundedJson } from "./artifactLimits.js";
import { canonicalize, contentHash } from "./canonical.js";
import { canonicalSigningIdentity, resolveDemosPrimaryClaimKey,
  type ResolvePrimaryClaimKey } from "./primaryClaimKey.js";
import { sdkListingSignatureVerifier } from "./sdkReaderVerifiers.js";

type Obj = Record<string, unknown>;
const MAX_COMMITMENT_PARTIES = 64;
const COMMITMENT_TIMEOUT_MS = 15_000;
const record = (v: unknown): Obj | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Obj : null;

/** Exact native record and receipt, with session authority resolved independently of candidate bytes. */
export interface CommitmentProof {
  record: Obj;
  nativeAddress: string;
  orchestrator: string;
  legacySignature?: ComponentSignature;
  receipt: AnchorReceipt;
}

/** Server-owned trust boundary, never supplied by a registration or artifact.
 * resolve authenticates session authority, native locator and immutable per-job record selection (CA-3).
 * verifyReceipt authenticates original consensus/execution evidence, network/profile, transaction,
 * writer and applicable nonce against the exact record. Receipt fields or RPC observations alone
 * MUST NOT return true. Both callbacks must bound network bytes before decoding and honor signal.
 * Missing/throwing/timed-out adapters refuse credit; no result is cached.
 */
export interface CommitmentVerifier {
  resolve: (jobId: string, signal: AbortSignal) => Promise<CommitmentProof | null>;
  verifyReceipt: (receipt: Readonly<AnchorReceipt>, raw: Readonly<Obj>, signal: AbortSignal) => Promise<boolean>;
}

/** Verified Listing bytes and withdrawal cutoff; null means an unresolved withdrawal. */
export interface ListingEvidence {
  locator: string;
  raw: Obj;
  withdrawnAt?: number | null;
}

/** Already authenticated agreement/bundle joins consumed by the commitment gate. */
export interface CommitmentContext {
  jobId: string;
  listingRef: unknown;
  agreementHash: string;
  pattern: unknown;
  parties: unknown[];
  deadline?: unknown;
}

type CommitmentResult = { ok: true; committedAt: number } | { ok: false; reason: string };
const refused = (reason: string): CommitmentResult => ({ ok: false, reason: `commitment verification failed: ${reason}` });

/** Verify signed commitment authority, finalized receipt and Listing timing; returns a refusal with its cause on failure. */
export async function verifyListingCommitment(context: CommitmentContext, listing: ListingEvidence,
  verifier?: CommitmentVerifier, resolveKey: ResolvePrimaryClaimKey = resolveDemosPrimaryClaimKey): Promise<CommitmentResult> {
  if (!verifier) return refused("no authenticated finality verifier");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("commitment proof timed out")), COMMITMENT_TIMEOUT_MS);
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([verifyProof(context, listing, verifier, resolveKey, controller.signal), aborted]);
  } catch (error) {
    return refused(error instanceof Error ? error.message : "proof could not be processed");
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    controller.abort();
  }
}

async function verifyProof(context: CommitmentContext, listing: ListingEvidence, verifier: CommitmentVerifier,
  resolveKey: ResolvePrimaryClaimKey, signal: AbortSignal): Promise<CommitmentResult> {
  const resolved = await verifier.resolve(context.jobId, signal);
  signal.throwIfAborted();
  const json = boundedJson(resolved);
  const proof = json ? record(JSON.parse(json)) : null;
  const raw = record(proof?.record);
  const receipt = proof?.receipt;
  const legacy = isCommitmentRecord(raw);
  if (!raw || (!legacy && !isReadableFinalityCommitmentRecord(raw)) ||
      (!legacy && Object.hasOwn(raw, "committedAt")) || !isReadableAnchorReceipt(receipt)) return refused("invalid record or receipt");
  const pin = record(context.listingRef);
  if (!pin || pin.listingId !== (listing.raw.listingId ?? listing.raw.serviceId) ||
      pin.version !== (listing.raw.listingVersion ?? listing.raw.version ?? 1)) return refused("Listing tuple mismatch");
  const parties = Array.isArray(raw.parties) ? raw.parties : [];
  const identities = (claims: unknown[]) => claims.map((claim) => typeof claim === "string" ? canonicalSigningIdentity(claim) : null);
  const expected = identities(context.parties);
  const actual = identities(parties);
  if (parties.length > MAX_COMMITMENT_PARTIES || actual.includes(null) || expected.includes(null) ||
      new Set(actual).size !== actual.length || actual.length !== expected.length || !expected.every((claim) => actual.includes(claim)) ||
      raw.jobId !== context.jobId || raw.agreementHash !== context.agreementHash || raw.pattern !== context.pattern ||
      canonicalize(raw.listingRef) !== canonicalize(context.listingRef)) return refused("agreement binding mismatch");
  const { signature: embedded, ...unsigned } = raw;
  const signature = record(legacy ? proof?.legacySignature : embedded);
  if (!isComponentSignature(signature) || signature.algorithm !== "ed25519" || typeof signature.signer !== "string" ||
      typeof proof?.orchestrator !== "string" || canonicalSigningIdentity(signature.signer) !== canonicalSigningIdentity(proof.orchestrator) ||
      !await sdkListingSignatureVerifier(resolveKey)({ signedBytes: Buffer.from(`${legacy ? "dacs-commitment:v1:" : "dacs-finality-commitment:v1:"}${contentHash(legacy ? raw : unsigned)}`),
        signature })) return refused("unauthenticated session orchestrator signature");
  if (receipt.state !== "finalized" || receipt.observationDisposition !== "established" ||
      receipt.logicalAddress !== `dacs3:commit:${encodeAddressSegment(context.jobId)}` ||
      receipt.nativeAddress !== proof.nativeAddress || !/^stor-[0-9a-f]{40}$/.test(receipt.nativeAddress) ||
      receipt.contentHash !== contentHash(raw) || !Number.isSafeInteger(receipt.blockRef?.timestamp) ||
      Number(receipt.blockRef?.timestamp) < 0) return refused("finalized receipt binding mismatch");
  // Pass independent copies: an adapter cannot change the timestamp or signed bytes used below.
  if (!await verifier.verifyReceipt(structuredClone(receipt), structuredClone(raw), signal)) return refused("receipt proof rejected");
  signal.throwIfAborted();
  const committedAt = Number(receipt.blockRef?.timestamp);
  if (legacy && raw.committedAt !== committedAt) return refused("legacy timestamp differs from consensus time");
  const validity = record(listing.raw.validity);
  if ((listing.raw.validity !== undefined && !validity) || [validity?.notBefore, validity?.notAfter].some((value) =>
    value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER))) {
    return refused("malformed signed Listing validity");
  }
  if ((typeof validity?.notBefore === "number" && committedAt < validity.notBefore) ||
      (typeof validity?.notAfter === "number" && committedAt > validity.notAfter)) return refused("outside signed Listing validity");
  if (listing.withdrawnAt === null || (listing.withdrawnAt !== undefined &&
      (!Number.isFinite(listing.withdrawnAt) || committedAt >= listing.withdrawnAt))) return refused("pre-withdrawal timing is unproven");
  const duration = record(listing.raw.terms)?.deadlineSecAfterCommit;
  if (duration !== undefined && (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0 ||
      typeof context.deadline !== "number" || !Number.isFinite(context.deadline) ||
      context.deadline > committedAt + duration * 1_000)) return refused("agreement deadline exceeds Listing bound");
  return { ok: true, committedAt };
}
