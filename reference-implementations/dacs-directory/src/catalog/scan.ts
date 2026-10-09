/**
 * Chain scanner — PASSIVE discovery. Walks the node's transaction history,
 * spots storage-program writes, and classifies anchored DACS artifacts by
 * their self-describing program names:
 *
 *   dacs1:listing:<did>:<serviceId>   → a listing  (owner = the seller)
 *   dacs5:bundle:<jobId>              → a buyer-anchored deal bundle
 *   dacs5:bundle:seller:<jobId>       → the seller's counter-signed copy
 *
 * Deal → seller attribution: the buyer-anchored agreement at
 * `dacs3:agreement:<jobId>` (owner-scoped to the bundle's owner) names the
 * seller. So one scan discovers agents nobody registered, their listings,
 * and their verifiable deal history — the catalog grows without submissions.
 *
 * Shape-defensive: the tx envelope is deep-walked for storage addresses
 * rather than assuming one schema (testnet payloads vary across versions).
 */
import { boundedJson, storageResponseJson, StorageResponseTooLarge, MAX_STORAGE_OWNER_LENGTH, MAX_STORAGE_NAME_LENGTH } from "./artifactLimits.js";
import { verifiedDiscoveryAgreement } from "./evidenceGraph.js";
import { isAgreementDocument } from "@kynesyslabs/dacs/artifacts";
import { verifyReferencedArtifactSignature } from "./bundlePolicy.js";
import { canonicalDemosAgentClaim } from "./claimRef.js";
import { programBindingKey } from "./store.js";
import { discoveredDealKey } from "./scanState.js";
import { agreementRail } from "./agreementMetadata.js";
import {
  boundedBundleBindings,
  verifyBundleBinding,
} from "./bundleBinding.js";
import type { BundleBinding, RegisteredDeal } from "./types.js";
import { contentHash } from "@kynesyslabs/dacs/canonical";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
const nonNegativeInt = (value: unknown, fallback: number): number => {
  const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

export interface ScannedArtifacts {
  /** listing anchor address → owner address */
  listings: Map<string, string>;
  /** buyer owner + jobId (discoveredDealKey) → discovered deal (buyer-anchored bundle + owners) */
  deals: Map<string, RegisteredDeal & { sellerFromAgreement?: string }>;
  /** owner + programName → observed native address. */
  programs: Map<string, string | null>;
  /** listing content hash → every revocation candidate seen in this window, oldest first. */
  revocations: Map<string, string[]>;
  /** jobId → BB-4-verified BundleBindings discovered in this scan window. */
  bundleBindings: Map<string, BundleBinding[]>;
  /** jobId + role keys whose deterministic total-work cap was exhausted. */
  bundleBindingOverflow: Set<string>;
  omittedBindings: number;
  txsScanned: number;
  /** Highest tx id observed — the next pass's cursor. */
  highestTxId: number;
  /** True only when the walk reached sinceTxId/genesis rather than maxTxs/error. */
  complete: boolean;
  chainTip: number;
  observations: Array<{ locator: string; kind: string; profile: string; owner?: string; contentHash?: string; observedAt: number; anchorTime?: number; data?: Record<string, unknown> }>;
  failures: Array<{ locator: string; kind: string; code: string; message: string }>;
  scanError?: string;
}

interface StorageRead {
  success?: boolean;
  owner?: string;
  programName?: string;
  data?: Record<string, unknown>;
  errorCode?: string;
  failureCode?: StorageReadFailureCode;
}

export type StorageReadFailureCode =
  | "STORAGE_NOT_FOUND"
  | "STORAGE_NOT_PUBLIC"
  | "STORAGE_RPC_UNAVAILABLE"
  | "STORAGE_INVALID_RESPONSE"
  | "ARTIFACT_REJECTED";

/** Safe cause classification; response bodies and upstream text are never persisted. */
export function storageReadFailureCode(status: number, errorCode?: string): StorageReadFailureCode {
  const normalized = typeof errorCode === "string" ? errorCode.trim().toUpperCase() : undefined;
  if (status === 404) {
    return "STORAGE_NOT_FOUND";
  }
  if (status === 401 || status === 403) {
    return "STORAGE_NOT_PUBLIC";
  }
  // A server-side or transport-class status remains retryable even if an
  // untrusted error body happens to carry a terminal-looking code.
  if (status >= 500 || status < 100) return "STORAGE_RPC_UNAVAILABLE";
  if (normalized === "NOT_FOUND" || normalized === "STORAGE_NOT_FOUND" || normalized === "PROGRAM_NOT_FOUND") {
    return "STORAGE_NOT_FOUND";
  }
  if (normalized === "PERMISSION_DENIED" || normalized === "UNAUTHORIZED") return "STORAGE_NOT_PUBLIC";
  return status >= 200 && status < 300 ? "STORAGE_INVALID_RESPONSE" : "STORAGE_RPC_UNAVAILABLE";
}

export async function readStorage(address: string, attempts = 3): Promise<StorageRead> {
  let lastFailure: StorageReadFailureCode = "STORAGE_RPC_UNAVAILABLE";
  const boundedAttempts = Number.isSafeInteger(attempts) && attempts >= 1 && attempts <= 5 ? attempts : 3;
  for (let attempt = 1; attempt <= boundedAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${RPC}/storage-program/${address}`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      lastFailure = "STORAGE_RPC_UNAVAILABLE";
      if (attempt < boundedAttempts) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
      continue;
    }

    const statusFailure = storageReadFailureCode(res.status);
    if (statusFailure === "STORAGE_NOT_FOUND" || statusFailure === "STORAGE_NOT_PUBLIC") {
      return { success: false, failureCode: statusFailure };
    }
    let body: StorageRead | null = null;
    try { body = (await storageResponseJson(res)) as StorageRead; } catch (error) {
      if (error instanceof StorageResponseTooLarge) return { success: false, failureCode: "ARTIFACT_REJECTED" };
    }
    const failure = storageReadFailureCode(res.status, body?.errorCode);
    if (failure === "STORAGE_NOT_FOUND" || failure === "STORAGE_NOT_PUBLIC") {
      return { success: false, failureCode: failure };
    }
    // DACS programs require object data; unrelated primitive payloads remain unclassified storage.
    if (
      res.ok && body?.success && typeof body.programName === "string" && body.programName &&
      body.programName.length <= MAX_STORAGE_NAME_LENGTH &&
      typeof body.owner === "string" && body.owner && body.owner.length <= MAX_STORAGE_OWNER_LENGTH &&
      (body.data == null || objectValue(body.data) || !/^dacs[0-9]+[:-]/.test(body.programName))
    ) return { ...body, data: objectValue(body.data) ?? undefined };
    lastFailure = failure;
    if (attempt < boundedAttempts) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
  }
  return { success: false, failureCode: lastFailure };
}

/**
 * Deep-walk any value collecting Demos-native `stor-…` addresses.
 *
 * DACS-5 logical bundle addresses carry 64 hex characters while Demos-native
 * locators carry 40. The trailing boundary is security-significant: without
 * it a logical address is silently truncated into a different, usually
 * unreadable native locator.
 */
export function collectNativeStorageAddresses(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    for (const m of value.matchAll(/stor-[0-9a-f]{40}(?![0-9a-f])/g)) out.add(m[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectNativeStorageAddresses(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectNativeStorageAddresses(v, out, depth + 1);
    }
  }
}

const didOf = (address: string): string =>
  `did:demos:agent:${address.replace(/^0x/, "")}`;

/**
 * Admit every candidate locator once. Discovery is never bounded by count: the
 * indexer bounds verification work per pass and drops a locator only after it
 * was read and rejected (REVOCATION_VERIFICATIONS_PER_PASS).
 */
export function addRevocationCandidate(revocations: Map<string, Set<string>>, listingHash: string, address: string): void {
  const candidates = revocations.get(listingHash) ?? new Set<string>();
  candidates.add(address);
  revocations.set(listingHash, candidates);
}

/**
 * Identify a DACS-1 revocation marker from its signed value, never from the
 * implementation-defined StorageProgram name. This is discovery only; the
 * indexer still performs the complete RB-4 hash, tuple, signer and signature
 * verification before publishing a revocation.
 */
export function isListingRevocationCandidate(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const marker = value as Record<string, unknown>;
  const signature = marker.signature;
  if (!signature || typeof signature !== "object" || Array.isArray(signature)) return false;
  const signed = signature as Record<string, unknown>;
  return (
    typeof marker.listingId === "string" &&
    /^[A-Za-z0-9._~-]{1,128}$/.test(marker.listingId) &&
    Number.isSafeInteger(marker.listingVersion) &&
    Number(marker.listingVersion) > 0 &&
    typeof marker.listingContentHash === "string" &&
    /^[0-9a-fA-F]{64}$/.test(marker.listingContentHash) &&
    Number.isSafeInteger(marker.revokedAt) &&
    Number(marker.revokedAt) >= 0 &&
    (marker.reason === undefined || typeof marker.reason === "string") &&
    (signed.algorithm === "ed25519" ||
      signed.algorithm === "ecdsa-secp256k1" ||
      signed.algorithm === "sr1-aggregate") &&
    typeof signed.signer === "string" &&
    typeof signed.value === "string"
  );
}

/** Unauthenticated nodeCall (plain fetch — no demosdk in the scan path). */
async function nodeCall(message: string, data: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  const res = await fetch(RPC + "/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      method: "nodeCall",
      params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data, extra: "" }],
    }),
  });
  const json = (await res.json()) as { result?: number; response?: unknown };
  if (json?.result !== 200) throw new Error(`nodeCall ${message} → ${json?.result}`);
  return json.response;
}

interface StorageWriteCandidate {
  locator: string;
  contentHash: string;
  blockNumber: number;
  transactionHash: string;
}

interface ConsensusAnchorObservation {
  locator: string;
  contentHash: string;
  anchorTime: number;
}

const objectValue = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const parsedObject = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string") return objectValue(value);
  try { return objectValue(JSON.parse(value)); } catch { return null; }
};

/**
 * Content hash of a storage payload the indexer can keep, or null. The hash
 * omits the signature envelope, which must still serialize for storage.
 */
function storableContentHash(data: Record<string, unknown>): string | null {
  try {
    if (boundedJson(data) === null) return null;
    return contentHash(data);
  } catch {
    return null;
  }
}

export async function validAgreementForDiscovery(data: Record<string, unknown>, jobId: string, buyer: string): Promise<boolean> {
  try {
    if (data.jobId !== jobId) return false;
    if (data.agreementVersion !== undefined || data.payeeBoundAgreementVersion !== undefined) {
      const parties = Array.isArray(data.parties) ? data.parties : [];
      return parties.some((p) => p && p.role === "buyer" && canonicalDemosAgentClaim(p.primaryClaim) === canonicalDemosAgentClaim(buyer)) &&
        parties.some((p) => p && p.role === "seller" && canonicalDemosAgentClaim(p.primaryClaim) !== null) &&
        await verifiedDiscoveryAgreement(data);
    }
    return isAgreementDocument(data) && canonicalDemosAgentClaim(data.buyer) === canonicalDemosAgentClaim(buyer) &&
      canonicalDemosAgentClaim(data.seller) !== null && await verifyReferencedArtifactSignature({
        kind: "dacs-3-agreement", raw: data,
      });
  } catch { return false; }
}

/** Exact target/content attribution for a whole-value StorageProgram write. */
export function storageWriteCandidate(value: unknown): StorageWriteCandidate | null {
  const tx = objectValue(value);
  if (!tx || tx.status !== "confirmed" || tx.type !== "storageProgram") return null;
  if (!Number.isSafeInteger(tx.blockNumber) || Number(tx.blockNumber) < 0) return null;
  if (typeof tx.hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(tx.hash)) return null;
  if (typeof tx.to !== "string" || !/^stor-[0-9a-f]{40}$/.test(tx.to)) return null;
  const envelope = parsedObject(tx.content);
  if (!envelope || envelope.type !== "storageProgram" || envelope.to !== tx.to) return null;
  if (!Array.isArray(envelope.data) || envelope.data.length !== 2 || envelope.data[0] !== "storageProgram") return null;
  const write = objectValue(envelope.data[1]);
  if (!write || (write.operation !== "CREATE_STORAGE_PROGRAM" && write.operation !== "WRITE_STORAGE")) return null;
  if (write.storageAddress !== tx.to) return null;
  const data = objectValue(write.data);
  if (!data) return null;
  let hash: string;
  const storableHash = storableContentHash(data);
  if (storableHash === null) return null;
  hash = storableHash;
  return {
    locator: tx.to,
    contentHash: hash,
    blockNumber: Number(tx.blockNumber),
    transactionHash: tx.hash.toLowerCase(),
  };
}

interface ConfirmedBlock {
  number: number;
  timestamp: number;
  transactionHashes: Set<string>;
}

async function confirmedBlock(
  blockNumber: number,
  cache: Map<number, Promise<ConfirmedBlock | null>>,
  timeoutMs = 30_000,
): Promise<ConfirmedBlock | null> {
  let pending = cache.get(blockNumber);
  if (!pending) {
    pending = (async () => {
      const block = objectValue(await nodeCall("getBlockByNumber", { blockNumber }, timeoutMs));
      const body = parsedObject(block?.content);
      if (!block || block.status !== "confirmed" || block.number !== blockNumber || !body) return null;
      if (!Number.isSafeInteger(body.timestamp) || Number(body.timestamp) < 0) return null;
      if (!Array.isArray(body.ordered_transactions)) return null;
      const timestamp = Number(body.timestamp) * 1_000;
      if (!Number.isSafeInteger(timestamp)) return null;
      return {
        number: blockNumber,
        timestamp,
        transactionHashes: new Set(body.ordered_transactions
          .filter((hash): hash is string => typeof hash === "string")
          .map((hash) => hash.toLowerCase())),
      };
    })();
    cache.set(blockNumber, pending);
  }
  return pending;
}

async function resolveConsensusAnchors(
  candidates: StorageWriteCandidate[],
  targets: ReadonlyMap<string, string>,
  deadline?: number,
): Promise<ConsensusAnchorObservation[]> {
  const blocks = new Map<number, Promise<ConfirmedBlock | null>>();
  const resolved = new Map<string, ConsensusAnchorObservation>();
  for (const candidate of candidates) {
    if (targets.get(candidate.locator) !== candidate.contentHash) continue;
    if (deadline !== undefined && Date.now() >= deadline) throw new Error("anchor backfill wall-clock budget exhausted");
    const timeoutMs = deadline === undefined ? 30_000 : Math.max(1, deadline - Date.now());
    const block = await confirmedBlock(candidate.blockNumber, blocks, timeoutMs);
    if (!block?.transactionHashes.has(candidate.transactionHash)) continue;
    const key = `${candidate.locator}\n${candidate.contentHash}`;
    const prior = resolved.get(key);
    if (!prior || block.timestamp < prior.anchorTime) {
      resolved.set(key, { locator: candidate.locator, contentHash: candidate.contentHash, anchorTime: block.timestamp });
    }
  }
  return [...resolved.values()];
}

export interface AnchorBackfillResult {
  observations: ConsensusAnchorObservation[];
  txsScanned: number;
  nextCursor?: number;
  complete: boolean;
}

/** Bounded, resumable descending history scan for current bundle content. */
export async function scanConsensusAnchorBackfill(
  targets: ReadonlyMap<string, string>,
  opts: { cursor?: number; maxTxs?: number; budgetMs?: number } = {},
): Promise<AnchorBackfillResult> {
  if (targets.size === 0) return { observations: [], txsScanned: 0, complete: true };
  const maxTxs = Math.max(1, Math.min(5_000, nonNegativeInt(opts.maxTxs, 500)));
  const budgetMs = Math.max(1_000, Math.min(60_000, nonNegativeInt(opts.budgetMs, 10_000)));
  const deadline = Date.now() + budgetMs;
  let cursor: number | "latest" = opts.cursor ?? "latest";
  let nextCursor: number | undefined = opts.cursor;
  let scanned = 0;
  let complete = false;
  const candidates: StorageWriteCandidate[] = [];
  while (scanned < maxTxs && Date.now() < deadline) {
    const limit = Math.min(100, maxTxs - scanned);
    const remaining = Math.max(1_000, deadline - Date.now());
    const page = ((await nodeCall("getTransactions", { start: cursor, limit }, remaining)) ?? []) as unknown[];
    if (page.length === 0) { complete = true; break; }
    const ids = page.map((tx) => objectValue(tx)?.id)
      .filter((id): id is number => Number.isSafeInteger(id) && Number(id) >= 0);
    for (const tx of page) {
      const candidate = storageWriteCandidate(tx);
      if (candidate && targets.get(candidate.locator) === candidate.contentHash) candidates.push(candidate);
    }
    scanned += page.length;
    if (ids.length === 0) throw new Error("anchor backfill page contained no valid transaction ids");
    const lowest = Math.min(...ids);
    if (lowest <= 1) { complete = true; nextCursor = undefined; break; }
    nextCursor = lowest - 1;
    cursor = nextCursor;
  }
  const observations = await resolveConsensusAnchors(candidates, targets, deadline);
  return { observations, txsScanned: scanned, nextCursor, complete };
}

/** Read the node's current transaction tip without advancing scan state. */
export async function readChainTip(): Promise<number> {
  const page = ((await nodeCall("getTransactions", { start: "latest", limit: 1 })) ?? []) as Array<{ id?: number }>;
  const id = page[0]?.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 0) {
    throw new Error("node returned no valid transaction tip");
  }
  return id;
}

/**
 * Scan recent transactions for DACS artifacts: page the node's tx history
 * (descending ids), deep-walk each tx for storage addresses, then read +
 * classify each unique address by its program name.
 */
export async function scanChain(
  _demos: unknown,
  opts: {
    maxTxs?: number;
    sinceTxId?: number;
    retryLocators?: string[];
    knownPrograms?: ReadonlyMap<string, string | null>;
  } = {},
): Promise<ScannedArtifacts> {
  // Incremental: walk latest → sinceTxId (exclusive) and stop. First run
  // (no cursor) backfills the whole history up to maxTxs.
  const maxTxs = nonNegativeInt(opts.maxTxs, 50_000);
  const since = nonNegativeInt(opts.sinceTxId, 0);
  const addresses = new Set<string>();
  for (const locator of opts.retryLocators ?? []) if (/^stor-[0-9a-f]{40}$/.test(locator)) addresses.add(locator);
  const writeCandidates: StorageWriteCandidate[] = [];
  let scanned = 0;
  let highestTxId = since;
  let complete = false;
  let chainTip = since;
  let scanError: string | undefined;
  const finalityDepth = nonNegativeInt(process.env.DACS_SCAN_FINALITY_DEPTH, 2);

  let cursor: number | "latest" = "latest";
  const PAGE = 100;
  while (scanned < maxTxs) {
    let page: Array<{ id?: number }> = [];
    try {
      page = ((await nodeCall("getTransactions", { start: cursor, limit: PAGE })) ?? []) as Array<{ id?: number }>;
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error);
      break;
    }
    if (page.length === 0) {
      complete = true;
      break;
    }
    const ids = page.map((t) => t.id).filter((i): i is number => typeof i === "number");
    if (cursor === "latest" && ids.length) chainTip = Math.max(...ids);
    const finalizedTip = Math.max(0, chainTip - finalityDepth);
    // Only txs beyond the cursor are new work.
    const fresh = page.filter((t) => typeof t.id !== "number" || (t.id > since && t.id <= finalizedTip));
    const freshIds = fresh.map((t) => t.id).filter((id): id is number => typeof id === "number");
    highestTxId = Math.max(highestTxId, ...(freshIds.length ? freshIds : [highestTxId]));
    scanned += fresh.length;
    for (const tx of fresh) {
      const inTx = new Set<string>(); collectNativeStorageAddresses(tx, inTx);
      for (const address of inTx) addresses.add(address);
      const candidate = storageWriteCandidate(tx);
      if (candidate) writeCandidates.push(candidate);
    }
    if (ids.length === 0) break;
    const lowest = Math.min(...ids);
    if (lowest <= since + 1 || lowest <= 1) {
      complete = true;
      break;
    }
    cursor = lowest - 1;
  }

  const listings = new Map<string, string>();
  const programs = new Map<string, string | null>(opts.knownPrograms);
  const revocations = new Map<string, Set<string>>();
  const bundleBindings = new Map<string, BundleBinding[]>();
  const bundleBindingOverflow = new Set<string>();
  const observations: ScannedArtifacts["observations"] = [];
  const failures: ScannedArtifacts["failures"] = [];
  const namesByLocator = new Map<string, string>();
  let omittedBindings = 0;
  const bundleOwners = new Map<string, { jobId: string; address: string; owner: string }>(); // owner + jobId → buyer bundle
  const sellerCopies = new Map<string, Array<{ address: string; owner: string }>>(); // preserve competing candidates
  const addSellerCopy = (jobId: string, address: string, owner: string) => {
    const copies = sellerCopies.get(jobId) ?? [];
    if (!copies.some((copy) => copy.address === address)) copies.push({ address, owner });
    sellerCopies.set(jobId, copies);
  };

  for (const address of addresses) {
    const read = await readStorage(address);
    if (!read?.success || !read.programName || !read.owner) {
      failures.push({
        locator: address,
        kind: "unknown",
        code: read?.failureCode ?? "STORAGE_INVALID_RESPONSE",
        message: "storage program could not be read under the public indexer policy",
      });
      continue;
    }
    const name = read.programName;
    namesByLocator.set(address, name);
    const data = read.data as Record<string, unknown> | undefined;
    const currentListing = data?.dacsVersion === "1" && typeof data.listingId === "string" && typeof data.listingVersion === "number";
    const currentBundle = (data?.bundleVersion === "1" || data?.faultBundleVersion === "1") &&
      typeof data.jobId === "string" && Array.isArray(data.parties);
    const profile = currentListing || currentBundle ? "dacs-v0.1" : "legacy-sdk-v0.1";
    const dataHash = data ? storableContentHash(data) : undefined;
    if (dataHash === null) {
      // No canonical form, so no DACS signature can cover it: unclassified storage.
      // Only bounded rejection metadata is kept, never the payload itself.
      observations.push({ locator: address, kind: "other", profile, owner: read.owner, observedAt: Date.now() });
      failures.push({ locator: address, kind: "other", code: "ARTIFACT_REJECTED", message: "storage artifact has no canonical JSON form" });
      continue;
    }
    // Duplicate owner/name programs are indeterminate, including across scan windows.
    const programKey = programBindingKey(read.owner, name);
    const knownProgram = programs.get(programKey);
    programs.set(programKey, knownProgram === undefined || knownProgram === address ? address : null);
    let artifactKind = "other";
    const verifiedBundleBinding = data?.bindingVersion === "1"
      ? await verifyBundleBinding(data)
      : null;
    if (data?.bindingVersion === "1" && !verifiedBundleBinding) omittedBindings++;
    if (verifiedBundleBinding) {
      artifactKind = "bundle-binding";
      const prior = bundleBindings.get(verifiedBundleBinding.jobId) ?? [];
      const bounded = boundedBundleBindings([...prior, verifiedBundleBinding]);
      bundleBindings.set(verifiedBundleBinding.jobId, bounded.bindings);
      for (const key of bounded.overflowKeys) bundleBindingOverflow.add(key);
    } else if (isListingRevocationCandidate(data)) {
      artifactKind = "listing-revocation";
      addRevocationCandidate(revocations, String(data!.listingContentHash).toLowerCase(), address);
    } else if (name.startsWith("dacs1:listing:") || name.startsWith("dacs1-") || currentListing) {
      artifactKind = "listing";
      listings.set(address, read.owner);
    } else if (currentBundle) {
      artifactKind = "bundle";
      const jobId = data!.jobId as string;
      const role = data!.anchoredByRole;
      if (role === "seller") addSellerCopy(jobId, address, read.owner);
      else bundleOwners.set(discoveredDealKey(read.owner, jobId), { jobId, address, owner: read.owner });
    } else if (name.startsWith("dacs5:bundle:seller:")) {
      artifactKind = "bundle";
      addSellerCopy(name.slice("dacs5:bundle:seller:".length), address, read.owner);
    } else if (name.startsWith("dacs5:bundle:")) {
      artifactKind = "bundle";
      const jobId = name.slice("dacs5:bundle:".length);
      bundleOwners.set(discoveredDealKey(read.owner, jobId), { jobId, address, owner: read.owner });
    }
    observations.push({ locator: address, kind: artifactKind, profile, owner: read.owner,
      contentHash: dataHash, observedAt: Date.now(), data });
  }

  const targets = new Map(observations
    .filter((observation): observation is typeof observation & { contentHash: string } =>
      observation.kind === "bundle" && typeof observation.contentHash === "string")
    .map((observation) => [observation.locator, observation.contentHash]));
  try {
    const anchors = await resolveConsensusAnchors(writeCandidates, targets);
    const byLocator = new Map(anchors.map((anchor) => [anchor.locator, anchor.anchorTime]));
    for (const observation of observations) observation.anchorTime = byLocator.get(observation.locator);
  } catch {
    // Consensus attribution is optional metadata. A block RPC failure must
    // retain the honest finalisedAt fallback and will be retried by backfill.
  }

  // Attribute each discovered deal to its seller via the buyer-anchored agreement.
  const deals = new Map<string, RegisteredDeal & { sellerFromAgreement?: string }>();
  for (const [dealKey, { jobId, ...bundle }] of bundleOwners) {
    const bundleName = namesByLocator.get(bundle.address);
    if (bundleName && programs.get(programBindingKey(bundle.owner, bundleName)) === null) continue;
    const agreementAddress = programs.get(programBindingKey(bundle.owner, `dacs3:agreement:${jobId}`));
    const agreement = agreementAddress ? await readStorage(agreementAddress) : null;
    const agreementData = agreement?.success && agreement.owner && agreement.programName === `dacs3:agreement:${jobId}` &&
      programBindingKey(agreement.owner, agreement.programName) === programBindingKey(bundle.owner, agreement.programName) &&
      agreement.data && storableContentHash(agreement.data) !== null &&
      await validAgreementForDiscovery(agreement.data, jobId, didOf(bundle.owner)) ? agreement.data : undefined;
    const agreementParties = Array.isArray(agreementData?.parties) ? agreementData.parties as Array<Record<string, unknown>> : [];
    const sellerFromAgreement = agreementData?.agreementVersion !== undefined || agreementData?.payeeBoundAgreementVersion !== undefined
      ? agreementParties.find((party) => party?.role === "seller" && typeof party.primaryClaim === "string")?.primaryClaim as string | undefined
      : typeof agreementData?.seller === "string" ? agreementData.seller : undefined;
    const candidates = sellerCopies.get(jobId) ?? [];
    const sellerCopy = sellerFromAgreement
      ? candidates.find((copy) => didOf(copy.owner) === sellerFromAgreement)
      : candidates.length === 1 ? candidates[0] : undefined;
    const seller = sellerFromAgreement;
    const rail = agreementRail(agreementData) ??
      ((agreementData?.price as { rail?: string } | undefined)?.rail) ??
      (((agreementData?.terms as Record<string, unknown> | undefined)?.price as { rail?: string } | undefined)?.rail) ?? "unknown";
    deals.set(dealKey, {
      jobId,
      rail,
      buyerBundleRef: bundle.address,
      sellerBundleRef: sellerCopy?.address,
      owners: { buyer: didOf(bundle.owner), seller: seller ?? "" },
      sellerFromAgreement: seller,
    });
  }

  // Transactions are walked newest first; candidates queue in chain order.
  return { listings, deals, programs,
    revocations: new Map([...revocations].map(([hash, candidates]) => [hash, [...candidates].reverse()])),
    bundleBindings, bundleBindingOverflow, omittedBindings,
    txsScanned: scanned, highestTxId, complete, chainTip, observations, failures, scanError };
}
