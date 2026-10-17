/**
 * The in-browser deal verifier's logic, kept apart from rendering so every verdict, label and
 * artifact read is testable. VerifyDeal.tsx only renders what these functions return.
 */
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  verifyBundleCore,
  type BundleVerification,
} from "@/vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import {
  browserDealVerdict,
  hasRequiredBundleSignatures,
  refsPassStrictPolicy,
  type ResolvedArtifact,
} from "@/src/catalog/bundlePolicy";

export type DealVerdict = "strict-pass" | "limited" | "fail";
export type RegisteredBundleRefs = { owners: unknown; buyerBundleRef: unknown; sellerBundleRef: unknown } | null;

export interface VerifyDealDeps {
  /** GET /api/dacs/artifact with the given query string. */
  fetchArtifact: (params: string) => Promise<Record<string, unknown> | null>;
  /** GET /api/dacs/deal-owners for the bundle's jobId and this bundle ref. */
  registeredBundleRefs: (jobId: string, bundleRef: string) => Promise<RegisteredBundleRefs>;
}

const keyFromDid = (did: string): Uint8Array | null => {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
};

// Mirrors the SDK's sessionAnchorName, which the pinned SDK_REV does not export
// publicly (fixed upstream after the pin: dacs-sdk#14).
const anchorName: Record<string, (jobId: string) => string> = {
  "dacs-3-agreement": (j) => `dacs3:agreement:${j}`,
  "dacs-4-evidence": (j) => `dacs4:evidence:${j}`,
  "dacs-2-verifyresult": (j) => `dacs2:verifyrecord:${j}`,
};

/** Repeat the strict legacy-profile checks over artifacts fetched through the Directory. */
export async function verifyDealInBrowser(
  input: { bundleRef: string; buyerOwner: string; expectedSeller?: string },
  deps: VerifyDealDeps,
): Promise<{ result: BundleVerification; verdict: DealVerdict }> {
  const { bundleRef, buyerOwner, expectedSeller } = input;
  const resolvedArtifacts: ResolvedArtifact[] = [];
  let rawBundle: Record<string, unknown> | null = null;
  const verification = await verifyBundleCore(bundleRef, {
    readArtifact: async (r) => {
      const raw = await deps.fetchArtifact(`ref=${encodeURIComponent(r)}`);
      if (r === bundleRef) rawBundle = raw;
      // The pinned SDK uses readArtifact only for the root and final listing;
      // agreement/evidence/vet artifacts enter through resolveRef below.
      if (raw && r !== bundleRef) resolvedArtifacts.push({ kind: "dacs-1-listing", raw });
      return raw;
    },
    resolveRef: async (kind, jobId) => {
      const name = anchorName[kind]?.(jobId);
      if (!name) return null;
      const raw = await deps.fetchArtifact(`owner=${encodeURIComponent(buyerOwner)}&name=${encodeURIComponent(name)}`);
      if (raw) resolvedArtifacts.push({ kind, raw });
      return raw;
    },
    resolvePublicKey: async (did) => keyFromDid(did),
    verify: async (b, s, p) => ed25519Verify(b, s, publicKeyFromRaw(p)),
  });
  const registered = verification.bundle?.jobId ? await deps.registeredBundleRefs(verification.bundle.jobId, bundleRef) : null;
  const signaturesOk = hasRequiredBundleSignatures(verification, rawBundle);
  const refsOk = signaturesOk ? await refsPassStrictPolicy(verification, resolvedArtifacts) : false;
  const outcome = browserDealVerdict({ verification, bundleRef, buyerOwner, expectedSeller, registered, signaturesOk, refsOk });
  return { result: { ...verification, ok: outcome.verdict === "strict-pass", reason: outcome.reason }, verdict: outcome.verdict };
}

/** The message shown when verification could not run at all. */
export function verificationErrorMessage(cause: unknown): string {
  return cause instanceof TypeError
    ? "The chain records could not be reached. Check the network and try again."
    : (cause as Error)?.message || "The artifact version is unsupported or malformed.";
}

export interface VerdictPresentation {
  tone: "ok" | "limited" | "err";
  headline: string;
  summary: string;
  checks: Array<{ label: string; detail: string; mark: "✓" | "✗" | "?"; ok: boolean }>;
}

/** The headline, summary and plain-language marks for a finished verification. */
export function verdictPresentation(result: BundleVerification, verdict: DealVerdict | null): VerdictPresentation {
  const strict = result.ok && verdict === "strict-pass";
  const limited = !strict && verdict === "limited";
  const signaturesValid = result.signatures.length > 0 && result.signatures.every((signature) => signature.verdict === "valid");
  const refsValid = result.refs.length > 0 && result.refs.every((ref) => ref.verdict === "ok");
  return {
    tone: strict ? "ok" : limited ? "limited" : "err",
    headline: strict ? "✓ Evidence is strictly verified"
      : limited ? "◇ Evidence is internally consistent; settlement or copy role unverified" : "✗ Evidence failed verification",
    summary: strict
      ? "The required parties signed, the copy role matches its registered address, and every referenced record matches its bundle hash."
      : limited
        ? "Signatures and referenced hashes are consistent; settlement or the registered copy address remains unverified."
        : result.reason ?? "One or more cryptographic checks failed.",
    checks: [
      { label: "Party signatures", detail: "Buyer and seller signatures must match the keys named in the bundle.", mark: signaturesValid ? "✓" : "✗", ok: signaturesValid },
      { label: "Referenced records", detail: "Agreement, payment, identity check, and original listing must remain unchanged.", mark: refsValid ? "✓" : "✗", ok: refsValid },
      { label: "Expected parties and copy address", detail: "The buyer, seller, and unhashed anchor role must match this directory's registered copy.",
        mark: strict ? "✓" : limited ? "?" : "✗", ok: strict },
    ],
  };
}

// Plain-language translations of the protocol's check names.
const REF_LABELS: Record<string, { what: string; means: string }> = {
  "dacs-3-agreement": { what: "The agreement", means: "what was promised, by whom, at what price — unchanged since it was signed" },
  "dacs-4-evidence": { what: "The payment record", means: "the settlement evidence, including the transaction reference — unchanged" },
  "dacs-2-verifyresult": { what: "The identity check", means: "the vetting that ran before any money moved — unchanged" },
  "dacs-1-listing": { what: "The original listing", means: "the service as it was advertised when this deal was struck — unchanged" },
};
const REF_FAIL: Record<string, string> = {
  missing: "can't be found on the chain",
  "invalid-shape": "isn't a valid record",
  "hash-mismatch": "has been ALTERED since the deal was signed",
  unresolved: "couldn't be located",
};

export interface DetailRow { key: string; title: string; text: string; id: string; ok: boolean; badge: string }

/** One row per party signature and per referenced record, for the technical disclosure. */
export function detailRows(result: BundleVerification): { signatures: DetailRow[]; refs: DetailRow[] } {
  return {
    signatures: result.signatures.map((signature) => {
      const role = result.bundle?.parties?.find((party) => party.primaryClaim === signature.party)?.role;
      const ok = signature.verdict === "valid";
      return {
        key: signature.party, title: role ? `The ${role}’s` : "A party’s", id: signature.party, ok,
        text: `signature is ${ok ? "cryptographically valid" : "NOT valid"}`, badge: ok ? "genuine ✓" : signature.verdict,
      };
    }),
    refs: result.refs.map((ref) => {
      const label = REF_LABELS[ref.kind];
      const ok = ref.verdict === "ok";
      return {
        key: `${ref.kind}/${ref.id}`, title: label?.what ?? ref.kind, id: `${ref.kind} · ${ref.id}`, ok,
        text: ok ? `— ${label?.means ?? "matches the chain record"}` : `— ${REF_FAIL[ref.verdict] ?? ref.verdict}`,
        badge: ok ? "untampered ✓" : "problem ✗",
      };
    }),
  };
}
