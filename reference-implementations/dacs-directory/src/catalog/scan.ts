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
import { programBindingKey } from "./store.js";
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
  /** jobId → discovered deal (buyer-anchored bundle + owners) */
  deals: Map<string, RegisteredDeal & { sellerFromAgreement?: string }>;
  /** owner + programName → observed native address. */
  programs: Map<string, string>;
  /** listing content hash → bounded, deterministic revocation candidates. */
  revocations: Map<string, string[]>;
  /** Candidate locators discarded by the per-listing resource bound. */
  revocationCandidatesTruncated: number;
  /** jobId → BB-4-verified BundleBindings discovered in this scan window. */
  bundleBindings: Map<string, BundleBinding[]>;
  /** jobId + role keys whose deterministic total-work cap was exhausted. */
  bundleBindingOverflow: Set<string>;
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
}

async function readStorage(address: string, attempts = 3): Promise<StorageRead | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) try {
    const res = await fetch(`${RPC}/storage-program/${address}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as StorageRead;
  } catch { if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1))); }
  return null;
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

export function addRevocationCandidate(
  revocations: Map<string, string[]>,
  listingHash: string,
  address: string,
  verifiedAddresses: ReadonlySet<string> = new Set(),
): number {
  const candidates = revocations.get(listingHash) ?? [];
  const merged = boundedRevocationCandidates([...candidates, address], verifiedAddresses);
  revocations.set(listingHash, merged.candidates);
  return merged.truncated;
}

export const MAX_REVOCATION_CANDIDATES_PER_LISTING = 16;

/**
 * Keep discovery state deterministic and bounded while never evicting a marker
 * that already passed RB-4 verification. Verified markers are signer-controlled
 * rather than public-shape-controlled, so they form the explicit bound exception.
 */
export function boundedRevocationCandidates(
  addresses: Iterable<string>,
  verifiedAddresses: ReadonlySet<string> = new Set(),
  limit = MAX_REVOCATION_CANDIDATES_PER_LISTING,
): { candidates: string[]; truncated: number } {
  // Include the persisted verified set even when an older scan-state snapshot
  // omitted that locator from its candidate array.
  const unique = [...new Set([...verifiedAddresses, ...addresses])];
  const verified = unique.filter((address) => verifiedAddresses.has(address));
  const unverified = unique.filter((address) => !verifiedAddresses.has(address));
  const candidates = [
    ...verified,
    ...unverified.slice(0, Math.max(0, limit - verified.length)),
  ];
  return { candidates, truncated: unique.length - candidates.length };
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
  return {
    locator: tx.to,
    contentHash: contentHash(data),
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
    verifiedRevocations?: ReadonlyMap<string, ReadonlySet<string>>;
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
  const programs = new Map<string, string>();
  const revocations = new Map<string, string[]>();
  let revocationCandidatesTruncated = 0;
  const bundleBindings = new Map<string, BundleBinding[]>();
  const bundleBindingOverflow = new Set<string>();
  const observations: ScannedArtifacts["observations"] = [];
  const failures: ScannedArtifacts["failures"] = [];
  const bundleOwners = new Map<string, { address: string; owner: string }>(); // jobId → buyer bundle
  const sellerCopies = new Map<string, Array<{ address: string; owner: string }>>(); // preserve competing candidates
  const addSellerCopy = (jobId: string, address: string, owner: string) => {
    const copies = sellerCopies.get(jobId) ?? [];
    if (!copies.some((copy) => copy.address === address)) copies.push({ address, owner });
    sellerCopies.set(jobId, copies);
  };

  for (const address of addresses) {
    const read = await readStorage(address);
    if (!read?.success || !read.programName || !read.owner) { failures.push({ locator: address, kind: "unknown", code: "STORAGE_UNREADABLE", message: "storage program could not be read after retries" }); continue; }
    const name = read.programName;
    programs.set(programBindingKey(read.owner, name), address);
    const data = read.data as Record<string, unknown> | undefined;
    const currentListing = data?.dacsVersion === "1" && typeof data.listingId === "string" && typeof data.listingVersion === "number";
    const currentBundle = (data?.bundleVersion === "1" || data?.faultBundleVersion === "1") &&
      typeof data.jobId === "string" && Array.isArray(data.parties);
    let artifactKind = "other";
    const verifiedBundleBinding = data?.bindingVersion === "1"
      ? await verifyBundleBinding(data)
      : null;
    if (verifiedBundleBinding) {
      artifactKind = "bundle-binding";
      const prior = bundleBindings.get(verifiedBundleBinding.jobId) ?? [];
      const bounded = boundedBundleBindings([...prior, verifiedBundleBinding]);
      bundleBindings.set(verifiedBundleBinding.jobId, bounded.bindings);
      for (const key of bounded.overflowKeys) bundleBindingOverflow.add(key);
    } else if (isListingRevocationCandidate(data)) {
      artifactKind = "listing-revocation";
      const listingHash = String(data!.listingContentHash).toLowerCase();
      revocationCandidatesTruncated += addRevocationCandidate(
        revocations,
        listingHash,
        address,
        opts.verifiedRevocations?.get(listingHash),
      );
    } else if (name.startsWith("dacs1:listing:") || name.startsWith("dacs1-") || currentListing) {
      artifactKind = "listing";
      listings.set(address, read.owner);
    } else if (currentBundle) {
      artifactKind = "bundle";
      const jobId = data!.jobId as string;
      const role = data!.anchoredByRole;
      if (role === "seller") addSellerCopy(jobId, address, read.owner);
      else bundleOwners.set(jobId, { address, owner: read.owner });
    } else if (name.startsWith("dacs5:bundle:seller:")) {
      artifactKind = "bundle";
      addSellerCopy(name.slice("dacs5:bundle:seller:".length), address, read.owner);
    } else if (name.startsWith("dacs5:bundle:")) {
      artifactKind = "bundle";
      bundleOwners.set(name.slice("dacs5:bundle:".length), { address, owner: read.owner });
    }
    observations.push({ locator: address, kind: artifactKind, profile: currentListing || currentBundle ? "dacs-v0.1" : "legacy-sdk-v0.1", owner: read.owner,
      contentHash: data ? contentHash(data) : undefined, observedAt: Date.now(), data });
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
  for (const [jobId, bundle] of bundleOwners) {
    const agreementAddress = programs.get(programBindingKey(bundle.owner, `dacs3:agreement:${jobId}`));
    const agreement = agreementAddress ? await readStorage(agreementAddress) : null;
    const agreementData = agreement?.data as Record<string, unknown> | undefined;
    const agreementParties = Array.isArray(agreementData?.parties) ? agreementData.parties as Array<Record<string, unknown>> : [];
    const sellerFromAgreement = typeof agreementData?.seller === "string" ? agreementData.seller
      : agreementParties.find((party) => party.role === "seller" && typeof party.primaryClaim === "string")?.primaryClaim as string | undefined;
    const candidates = sellerCopies.get(jobId) ?? [];
    const sellerCopy = sellerFromAgreement
      ? candidates.find((copy) => didOf(copy.owner) === sellerFromAgreement)
      : candidates.length === 1 ? candidates[0] : undefined;
    const seller = sellerFromAgreement ?? (sellerCopy ? didOf(sellerCopy.owner) : undefined);
    const rail = agreementRail(agreementData) ??
      ((agreementData?.price as { rail?: string } | undefined)?.rail) ??
      (((agreementData?.terms as Record<string, unknown> | undefined)?.price as { rail?: string } | undefined)?.rail) ?? "unknown";
    deals.set(jobId, {
      jobId,
      rail,
      buyerBundleRef: bundle.address,
      sellerBundleRef: sellerCopy?.address,
      owners: { buyer: didOf(bundle.owner), seller: seller ?? "" },
      sellerFromAgreement: seller,
    });
  }

  return { listings, deals, programs, revocations, revocationCandidatesTruncated,
    bundleBindings, bundleBindingOverflow,
    txsScanned: scanned, highestTxId, complete, chainTip, observations, failures, scanError };
}
