import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { bundleSignerPolicy } from "./bundleSignerPolicy.js";
import { verifyListing } from "./listingVerification.js";

export type ArtifactKind = "agreement" | "evidence" | "verify-result" | "composite" | "rating" | "listing" | "bundle" | "attestation";
export interface CurrentRef { anchor: { kind: string; locator: string }; contentHash: string; [key: string]: unknown }
export interface ResolvedEvidence { kind: ArtifactKind; ref?: CurrentRef; locator: string; raw: Record<string, unknown>; contentHash: string }
export interface EvidenceGraph {
  profile: "dacs-v0.1";
  ok: boolean;
  reason?: string;
  bundle: Record<string, unknown>;
  bundleContentHash: string;
  signaturesVerified: boolean;
  refsVerified: boolean;
  artifacts: ResolvedEvidence[];
  agreement?: Record<string, unknown>;
  listing?: Record<string, unknown>;
  ratings: Record<string, unknown>[];
}
export interface EvidenceGraphDeps {
  read: (locator: string) => Promise<Record<string, unknown> | null>;
  resolveListing: (ref: Record<string, unknown>) => Promise<{ locator: string; raw: Record<string, unknown> } | null>;
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const arr = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.map(rec).filter(Boolean) as Record<string, unknown>[] : [];
const OUTCOMES = new Set(["completed", "failed-perm", "failed-counterparty", "failed-substrate", "aborted-by-self", "aborted-by-other"]);
const PHASE_OUTCOMES = new Set(["ok", "fail"]);
const ERROR_CLASSES = new Set(["permanent", "transient", "counterparty", "substrate", "settlement-atomicity"]);
const MAX_GRAPH_ARTIFACTS = 64;
const withinArtifactLimit = (raw: Record<string, unknown>): boolean => Buffer.byteLength(JSON.stringify(raw), "utf8") <= 65_536;
const priceTermOk = (value: unknown): boolean => {
  const price = rec(value); const amount = String(price?.amount ?? "");
  return Boolean(price && /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(amount) && /[1-9]/.test(amount) &&
    typeof price.currency === "string" && price.currency.length > 0 && price.currency.length <= 64);
};
const SEPARATORS: Record<Exclude<ArtifactKind, "attestation">, string> = {
  agreement: "dacs-agreement:v1:", evidence: "dacs-evidence:v1:", "verify-result": "dacs-verifyresult:v1:",
  composite: "dacs-composite:v1:", rating: "dacs-rating:v1:", listing: "dacs-listing:v1:", bundle: "dacs-bundle:v1:",
};

export function signedScope(raw: Record<string, unknown>, kind: ArtifactKind): Record<string, unknown> {
  if (kind === "attestation") return { ...raw };
  const scope = { ...raw };
  if (kind === "bundle") {
    delete scope.signatures;
    delete scope.anchoredByRole;
  } else if (kind === "agreement") delete scope.signatures;
  else delete scope.signature;
  return scope;
}
export const artifactHash = (raw: Record<string, unknown>, kind: ArtifactKind): string => contentHash(signedScope(raw, kind));
const normalizedHash = (value: unknown): string => typeof value === "string" ? value.replace(/^sha256[:-]/i, "").toLowerCase() : "";

function decodeSignature(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const hex = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(hex)) return Uint8Array.from(Buffer.from(hex, "hex"));
  try { const bytes = Buffer.from(value, "base64url"); return bytes.length === 64 ? Uint8Array.from(bytes) : null; } catch { return null; }
}
export function claimKey(claim: unknown): ReturnType<typeof publicKeyFromRaw> | null {
  const hex = typeof claim === "string" ? claim.match(/([0-9a-fA-F]{64})$/)?.[1] : undefined;
  if (!hex) return null;
  try { return publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex"))); } catch { return null; }
}
export function verifyComponentSignature(raw: Record<string, unknown>, kind: ArtifactKind, signature: Record<string, unknown>): boolean {
  if (kind === "attestation") return false;
  if (signature.algorithm !== "ed25519" || typeof signature.signer !== "string") return false;
  const key = claimKey(signature.signer); const value = decodeSignature(signature.value);
  if (!key || !value) return false;
  return ed25519Verify(Buffer.from(SEPARATORS[kind] + artifactHash(raw, kind), "utf8"), value, key);
}
function verifyBundleSignature(raw: Record<string, unknown>, signature: Record<string, unknown>): boolean {
  const party = signature.party;
  if (signature.algorithm !== "ed25519" || typeof party !== "string") return false;
  const key = claimKey(party); const value = decodeSignature(signature.value);
  if (!key || !value) return false;
  return ed25519Verify(Buffer.from(SEPARATORS.bundle + artifactHash(raw, "bundle"), "utf8"), value, key);
}

export function isCurrentRef(value: unknown): value is CurrentRef {
  const ref = rec(value); const anchor = rec(ref?.anchor);
  return Boolean(anchor && anchor.kind === "storage-program" && typeof anchor.locator === "string" && /^stor-[0-9a-f]{40}$/.test(anchor.locator) && /^[0-9a-f]{64}$/.test(normalizedHash(ref?.contentHash)));
}
function shapeOk(raw: Record<string, unknown>, kind: ArtifactKind): boolean {
  if (kind === "agreement") return raw.agreementVersion === "1" && typeof raw.jobId === "string" && rec(raw.listingRef) !== null && arr(raw.parties).length >= 2 && priceTermOk(rec(raw.terms)?.price);
  if (kind === "evidence") return raw.evidenceVersion === "1" && typeof raw.jobId === "string" && typeof raw.phase === "string" && (raw.outcome === "success" || raw.outcome === "failure") && typeof raw.observedAt === "number" && (raw.amendmentRefs === undefined || Array.isArray(raw.amendmentRefs)) && (raw.attestationRef === undefined || isCurrentRef(raw.attestationRef));
  if (kind === "verify-result") return raw.resultVersion === "1" && typeof raw.scheme === "string" && typeof raw.identifier === "string" && typeof raw.verifiedAt === "number" && ["pass", "fail", "indeterminate", "error"].includes(String(raw.decision)) && isCurrentRef(raw.attestation);
  if (kind === "composite") {
    const supplementary = arr(raw.supplementary);
    return raw.recordVersion === "1" && typeof raw.jobId === "string" && typeof raw.evaluatedParty === "string" && ["pass", "fail", "indeterminate", "error"].includes(String(raw.overallDecision)) && Array.isArray(raw.freshness) && Array.isArray(raw.dealSpecific) && Array.isArray(raw.supplementary) && supplementary.length === raw.supplementary.length && supplementary.every((signal) => typeof signal.source === "string" && typeof signal.signalType === "string" && (typeof signal.value === "number" || typeof signal.value === "string") && typeof signal.observedAt === "number" && (signal.attestation === undefined ? signal.source !== "external" : isCurrentRef(signal.attestation)));
  }
  if (kind === "rating") return raw.ratingVersion === "1" && typeof raw.jobId === "string" && typeof raw.rater === "string" && typeof raw.target === "string" && (raw.targetRole === "buyer" || raw.targetRole === "seller") && Number.isInteger(raw.value) && Number(raw.value) >= 1 && Number(raw.value) <= 5 && typeof raw.ratedAt === "number" && (typeof raw.freeText !== "string" || raw.freeText.length <= 1000);
  return true;
}
function signatureOk(raw: Record<string, unknown>, kind: ArtifactKind): boolean {
  if (kind === "agreement") {
    const signatures = arr(raw.signatures);
    if (raw.signature !== undefined || !Array.isArray(raw.signatures) || signatures.length !== raw.signatures.length ||
        !signatures.every((signature) => verifyComponentSignature(raw, kind,
          { ...signature, signer: signature.signer ?? signature.party }))) return false;
    const parties = arr(raw.parties);
    const required = parties.filter((party) => party.role === "buyer" || party.role === "seller").map((party) => party.primaryClaim);
    const valid = new Set(signatures.map((signature) => signature.signer ?? signature.party));
    return required.length === 2 && required.every((claim) => valid.has(claim));
  }
  if (raw.signatures !== undefined) return false;
  const signature = rec(raw.signature);
  if (kind === "rating" && signature?.signer !== raw.rater) return false;
  return Boolean(signature && verifyComponentSignature(raw, kind, signature));
}

async function resolveRef(kind: ArtifactKind, ref: unknown, deps: EvidenceGraphDeps): Promise<ResolvedEvidence | null> {
  if (kind === "attestation") {
    if (!isCurrentRef(ref)) return null;
    const hash = normalizedHash(ref.contentHash);
    const raw = await deps.read(ref.anchor.locator);
    if (!raw || !withinArtifactLimit(raw) || contentHash(raw) !== hash) return null;
    return { kind, ref, locator: ref.anchor.locator, raw, contentHash: hash };
  }
  if (!isCurrentRef(ref)) return null;
  const hash = normalizedHash(ref.contentHash);
  const raw = await deps.read(ref.anchor.locator); if (!raw || !withinArtifactLimit(raw) || !shapeOk(raw, kind) || artifactHash(raw, kind) !== hash || !signatureOk(raw, kind)) return null;
  return { kind, ref, locator: ref.anchor.locator, raw, contentHash: hash };
}

export async function buildCurrentEvidenceGraph(bundleLocator: string, deps: EvidenceGraphDeps): Promise<EvidenceGraph> {
  const raw = await deps.read(bundleLocator);
  const fail = (reason: string): EvidenceGraph => ({ profile: "dacs-v0.1", ok: false, reason, bundle: raw ?? {}, bundleContentHash: raw ? artifactHash(raw, "bundle") : "", signaturesVerified: false, refsVerified: false, artifacts: [], ratings: [] });
  const phases = arr(raw?.phaseSummary);
  const phaseIndexes = phases.map((phase) => phase.index);
  if (!raw || !withinArtifactLimit(raw) || raw.signature !== undefined || raw.bundleVersion !== "1" || typeof raw.jobId !== "string" || !OUTCOMES.has(String(raw.outcome)) || !["buyer", "seller", "orchestrator"].includes(String(raw.anchoredByRole)) || !rec(raw.listingRef) || arr(raw.parties).length < 2 || !Array.isArray(raw.phaseSummary) || phases.length !== raw.phaseSummary.length || phases.some((phase) => !Number.isSafeInteger(phase.index) || Number(phase.index) < 0 || typeof phase.kind !== "string" || !PHASE_OUTCOMES.has(String(phase.outcome)) || (phase.errorClass !== undefined && !ERROR_CLASSES.has(String(phase.errorClass)))) || new Set(phaseIndexes).size !== phaseIndexes.length || !Array.isArray(raw.vetRecords) || !Array.isArray(raw.settlementEvidence) || (raw.ratingRefs !== undefined && !Array.isArray(raw.ratingRefs)) || (raw.amendments !== undefined && (!Array.isArray(raw.amendments) || raw.amendments.length > 0)) || !Number.isSafeInteger(raw.recipeRegistryVersion) || Number(raw.recipeRegistryVersion) < 1 || !Number.isSafeInteger(raw.railRegistryVersion) || Number(raw.railRegistryVersion) < 1 || typeof raw.finalisedAt !== "number") return fail("invalid current DACS-5 bundle shape");
  const signatures = arr(raw.signatures); const parties = arr(raw.parties);
  if (new Set(parties.map((party) => party.role)).size !== parties.length ||
      !parties.some((party) => party.role === "buyer") || !parties.some((party) => party.role === "seller") ||
      parties.some((party) => !["buyer", "seller", "orchestrator"].includes(String(party.role)) || typeof party.primaryClaim !== "string" || !/^[0-9a-f]{64}$/.test(normalizedHash(party.bundleHash)))) return fail("invalid or duplicate bundle parties");
  if (!Array.isArray(raw.signatures) || signatures.length !== raw.signatures.length) {
    return fail("bundle signatures contain malformed entries");
  }
  const signatureChecks = signatures.map((signature) => ({
    party: signature.party,
    valid: verifyBundleSignature(raw, signature),
  }));
  const validParties = signatureChecks.filter((check) => check.valid && typeof check.party === "string")
    .map((check) => check.party as string);
  const signaturesVerified = bundleSignerPolicy(raw, validParties,
    signatureChecks.length > 0 && signatureChecks.every((check) => check.valid));
  if (!signaturesVerified) return fail("required current bundle signatures are missing or invalid");

  const abort = raw.outcome === "aborted-by-self" || raw.outcome === "aborted-by-other";

  const artifacts: ResolvedEvidence[] = [];
  const topLevelLocators = new Map<string, { kind: ArtifactKind; hash: string }>();
  const strictTopLevelHashes = new Set<string>();
  const reserveTopLevelRef = (kind: ArtifactKind, value: unknown): "new" | "duplicate-rating" | "invalid" => {
    if (!isCurrentRef(value)) return "invalid";
    const locator = value.anchor.locator;
    const hash = normalizedHash(value.contentHash);
    const existing = topLevelLocators.get(locator);
    if (existing) {
      return kind === "rating" && existing.kind === "rating" && existing.hash === hash
        ? "duplicate-rating" : "invalid";
    }
    if (kind !== "rating" && strictTopLevelHashes.has(hash)) return "invalid";
    topLevelLocators.set(locator, { kind, hash });
    if (kind !== "rating") strictTopLevelHashes.add(hash);
    return "new";
  };
  let agreement: Record<string, unknown> | undefined;
  if (raw.agreementRef !== undefined) {
    if (reserveTopLevelRef("agreement", raw.agreementRef) !== "new") return { ...fail("duplicate or invalid top-level reference"), signaturesVerified };
    const resolved = await resolveRef("agreement", raw.agreementRef, deps); if (!resolved) return { ...fail("agreement reference failed"), signaturesVerified };
    if (resolved.raw.jobId !== raw.jobId) return { ...fail("agreement belongs to another job"), signaturesVerified };
    artifacts.push(resolved); agreement = resolved.raw;
  } else if (!abort) return { ...fail("non-abort bundle has no agreement"), signaturesVerified };
  for (const [kind, refs] of [["evidence", raw.settlementEvidence], ["composite", raw.vetRecords], ["rating", raw.ratingRefs]] as Array<[ArtifactKind, unknown]>) {
    for (const ref of Array.isArray(refs) ? refs : []) {
      if (artifacts.length >= MAX_GRAPH_ARTIFACTS) return { ...fail("evidence graph exceeds size limit"), signaturesVerified };
      const reserved = reserveTopLevelRef(kind, ref);
      if (reserved === "invalid") return { ...fail("duplicate or invalid top-level reference"), signaturesVerified };
      if (reserved === "duplicate-rating") continue;
      const resolved = await resolveRef(kind, ref, deps); if (!resolved) return { ...fail(`${kind} reference failed`), signaturesVerified };
      if ((kind === "evidence" || kind === "rating" || kind === "composite") && resolved.raw.jobId !== raw.jobId) return { ...fail(`${kind} belongs to another job`), signaturesVerified };
      if (kind === "rating") {
        const target = parties.find((party) => party.primaryClaim === resolved.raw.target);
        if (!parties.some((party) => party.primaryClaim === resolved.raw.rater) ||
            !target || target.role !== resolved.raw.targetRole) {
          return { ...fail("rating party binding failed"), signaturesVerified };
        }
      }
      if (kind === "evidence" && !parties.some((party) => party.primaryClaim === rec(resolved.raw.signature)?.signer)) return { ...fail("evidence signer is not a session party"), signaturesVerified };
      artifacts.push(resolved);
    }
  }
  // Resolve the transitive evidence graph, not only the bundle's first-level
  // pointers. Cycles and repeated refs collapse only when kind, locator, and
  // content hash all agree.
  const seen = new Map(artifacts.map((artifact) => [
    `${artifact.kind}\n${artifact.locator}`, artifact.contentHash,
  ]));
  let graphLimitExceeded = false;
  const addNested = async (kind: ArtifactKind, value: unknown): Promise<boolean> => {
    if (!isCurrentRef(value)) return false;
    const key = `${kind}\n${value.anchor.locator}`;
    const hash = normalizedHash(value.contentHash);
    if (seen.has(key)) return seen.get(key) === hash;
    if (artifacts.length >= MAX_GRAPH_ARTIFACTS) { graphLimitExceeded = true; return false; }
    const nested = await resolveRef(kind, value, deps); if (!nested) return false;
    if ((kind === "evidence" || kind === "composite") && nested.raw.jobId !== raw.jobId) return false;
    if (kind === "evidence" && !parties.some((party) => party.primaryClaim === rec(nested.raw.signature)?.signer)) return false;
    seen.set(key, nested.contentHash); artifacts.push(nested); return true;
  };
  for (let index = 0; index < artifacts.length; index++) {
    const artifact = artifacts[index];
    if (artifact.kind === "composite") {
      for (const key of ["freshness", "dealSpecific"] as const) for (const value of Array.isArray(artifact.raw[key]) ? artifact.raw[key] as unknown[] : []) {
        if (!(await addNested("verify-result", value))) return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "nested VerifyResult reference failed"), signaturesVerified };
      }
      for (const signal of arr(artifact.raw.supplementary)) if (signal.attestation !== undefined && !(await addNested("attestation", signal.attestation))) {
        return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "supplementary attestation reference failed"), signaturesVerified };
      }
    }
    if (artifact.kind === "evidence") {
      if (artifact.raw.attestationRef !== undefined && !(await addNested("attestation", artifact.raw.attestationRef))) {
        return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "delivery attestation reference failed"), signaturesVerified };
      }
      for (const value of Array.isArray(artifact.raw.amendmentRefs) ? artifact.raw.amendmentRefs as unknown[] : []) {
        if (!(await addNested("evidence", value))) return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "settlement amendment reference failed"), signaturesVerified };
      }
      for (const key of ["supersedesEvidenceRef", "amendsEvidenceRef"] as const) if (artifact.raw[key] !== undefined && !(await addNested("evidence", artifact.raw[key]))) {
        return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "settlement evidence chain failed"), signaturesVerified };
      }
    }
    if (artifact.kind === "verify-result" && !(await addNested("attestation", artifact.raw.attestation))) {
      return { ...fail(graphLimitExceeded ? "evidence graph exceeds size limit" : "VerifyResult attestation reference failed"), signaturesVerified };
    }
  }
  const verifiedPhaseRefs = new Set(artifacts.filter((artifact) => artifact.ref &&
    (artifact.kind === "evidence" || artifact.kind === "verify-result")).map((artifact) =>
    `${artifact.ref!.anchor.locator}\n${normalizedHash(artifact.ref!.contentHash)}`));
  for (const phase of arr(raw.phaseSummary)) {
    if (phase.attestationRef === undefined) continue;
    if (!isCurrentRef(phase.attestationRef) ||
        !verifiedPhaseRefs.has(`${phase.attestationRef.anchor.locator}\n${normalizedHash(phase.attestationRef.contentHash)}`)) {
      return { ...fail("phase attestation reference is outside the verified graph"), signaturesVerified };
    }
  }
  if (artifacts.length >= MAX_GRAPH_ARTIFACTS) return { ...fail("evidence graph exceeds size limit"), signaturesVerified };
  const listingRef = rec(raw.listingRef)!;
  const listed = await deps.resolveListing(listingRef);
  const listingHash = normalizedHash(listingRef.contentHash);
  if (!listed || artifactHash(listed.raw, "listing") !== listingHash || !(await verifyListing(listed.raw))) return { ...fail("listing reference failed"), signaturesVerified };
  if (agreement && JSON.stringify(agreement.listingRef) !== JSON.stringify(raw.listingRef)) return { ...fail("agreement listing binding failed"), signaturesVerified };
  if (agreement) {
    const agreementParties = arr(agreement.parties);
    if (!["buyer", "seller"].every((role) => agreementParties.some((candidate) => candidate.role === role && parties.some((party) => party.role === role && party.primaryClaim === candidate.primaryClaim)))) {
      return { ...fail("agreement party binding failed"), signaturesVerified };
    }
  }
  artifacts.push({ kind: "listing", locator: listed.locator, raw: listed.raw, contentHash: listingHash });
  return { profile: "dacs-v0.1", ok: true, bundle: raw, bundleContentHash: artifactHash(raw, "bundle"), signaturesVerified, refsVerified: true, artifacts, agreement, listing: listed.raw, ratings: artifacts.filter((artifact) => artifact.kind === "rating").map((artifact) => artifact.raw) };
}

export function agreementPrice(agreement: Record<string, unknown> | undefined): { amount: string; currency: string } | null {
  const price = rec(rec(agreement?.terms)?.price);
  return priceTermOk(price) ? { amount: price!.amount as string, currency: price!.currency as string } : null;
}
