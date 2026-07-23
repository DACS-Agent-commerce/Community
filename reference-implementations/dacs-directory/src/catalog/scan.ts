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
import type { RegisteredDeal } from "./types.js";

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
  /** listing content hash → every observed revocation marker candidate. */
  revocations: Map<string, string[]>;
  txsScanned: number;
  /** Highest tx id observed — the next pass's cursor. */
  highestTxId: number;
  /** True only when the walk reached sinceTxId/genesis rather than maxTxs/error. */
  complete: boolean;
  chainTip: number;
  observations: Array<{ locator: string; kind: string; profile: string; owner?: string; observedAt: number; anchorTime?: number; data?: Record<string, unknown> }>;
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

/** Deep-walk any value collecting `stor-…` addresses (shape-agnostic). */
function collectStorageAddresses(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 8 || value == null) return;
  if (typeof value === "string") {
    for (const m of value.matchAll(/stor-[0-9a-f]{40}/g)) out.add(m[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectStorageAddresses(v, out, depth + 1);
    return;
  }
  if (typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) {
      collectStorageAddresses(v, out, depth + 1);
    }
  }
}

const didOf = (address: string): string =>
  `did:demos:agent:${address.replace(/^0x/, "")}`;

export function addRevocationCandidate(
  revocations: Map<string, string[]>,
  listingHash: string,
  address: string,
): void {
  const candidates = revocations.get(listingHash) ?? [];
  if (!candidates.includes(address)) candidates.push(address);
  revocations.set(listingHash, candidates);
}

/** Unauthenticated nodeCall (plain fetch — no demosdk in the scan path). */
async function nodeCall(message: string, data: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(RPC + "/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      method: "nodeCall",
      params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data, extra: "" }],
    }),
  });
  const json = (await res.json()) as { result?: number; response?: unknown };
  if (json?.result !== 200) throw new Error(`nodeCall ${message} → ${json?.result}`);
  return json.response;
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
  opts: { maxTxs?: number; sinceTxId?: number; retryLocators?: string[] } = {},
): Promise<ScannedArtifacts> {
  // Incremental: walk latest → sinceTxId (exclusive) and stop. First run
  // (no cursor) backfills the whole history up to maxTxs.
  const maxTxs = nonNegativeInt(opts.maxTxs, 50_000);
  const since = nonNegativeInt(opts.sinceTxId, 0);
  const addresses = new Set<string>();
  for (const locator of opts.retryLocators ?? []) if (/^stor-[0-9a-f]{40}$/.test(locator)) addresses.add(locator);
  const addressTimes = new Map<string, number>();
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
      const inTx = new Set<string>(); collectStorageAddresses(tx, inTx);
      const timestamp = typeof (tx as { timestamp?: unknown }).timestamp === "number" ? (tx as { timestamp: number }).timestamp : undefined;
      for (const address of inTx) { addresses.add(address); if (timestamp !== undefined && !addressTimes.has(address)) addressTimes.set(address, timestamp); }
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
    const currentBundle = data?.bundleVersion === "1" && typeof data.jobId === "string" && Array.isArray(data.parties);
    let artifactKind = "other";
    if (name.startsWith("dacs1:listing:") || name.startsWith("dacs1-") || currentListing) {
      artifactKind = "listing";
      listings.set(address, read.owner);
    } else if (name.startsWith("dacs1-revoked:")) {
      artifactKind = "listing-revocation";
      const listingHash = typeof read.data?.listingContentHash === "string"
        ? read.data.listingContentHash.toLowerCase()
        : null;
      if (listingHash) addRevocationCandidate(revocations, listingHash, address);
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
      observedAt: Date.now(), anchorTime: addressTimes.get(address), data });
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
    const rail =
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

  return { listings, deals, programs, revocations, txsScanned: scanned, highestTxId, complete, chainTip, observations, failures, scanError };
}
