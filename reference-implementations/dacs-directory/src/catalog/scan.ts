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
}

interface StorageRead {
  success?: boolean;
  owner?: string;
  programName?: string;
  data?: Record<string, unknown>;
}

async function readStorage(address: string): Promise<StorageRead | null> {
  try {
    const res = await fetch(`${RPC}/storage-program/${address}`, {
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as StorageRead;
  } catch {
    return null;
  }
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

/**
 * Scan recent transactions for DACS artifacts: page the node's tx history
 * (descending ids), deep-walk each tx for storage addresses, then read +
 * classify each unique address by its program name.
 */
export async function scanChain(
  _demos: unknown,
  opts: { maxTxs?: number; sinceTxId?: number } = {},
): Promise<ScannedArtifacts> {
  // Incremental: walk latest → sinceTxId (exclusive) and stop. First run
  // (no cursor) backfills the whole history up to maxTxs.
  const maxTxs = opts.maxTxs ?? 50_000;
  const since = opts.sinceTxId ?? 0;
  const addresses = new Set<string>();
  let scanned = 0;
  let highestTxId = since;
  let complete = false;

  let cursor: number | "latest" = "latest";
  const PAGE = 100;
  while (scanned < maxTxs) {
    let page: Array<{ id?: number }> = [];
    try {
      page = ((await nodeCall("getTransactions", { start: cursor, limit: PAGE })) ?? []) as Array<{ id?: number }>;
    } catch {
      break;
    }
    if (page.length === 0) {
      complete = true;
      break;
    }
    const ids = page.map((t) => t.id).filter((i): i is number => typeof i === "number");
    highestTxId = Math.max(highestTxId, ...(ids.length ? ids : [highestTxId]));
    // Only txs beyond the cursor are new work.
    const fresh = page.filter((t) => typeof t.id !== "number" || t.id > since);
    scanned += fresh.length;
    for (const tx of fresh) collectStorageAddresses(tx, addresses);
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
  const bundleOwners = new Map<string, { address: string; owner: string }>(); // jobId → buyer bundle
  const sellerCopies = new Map<string, string>(); // jobId → seller owner

  for (const address of addresses) {
    const read = await readStorage(address);
    if (!read?.success || !read.programName || !read.owner) continue;
    const name = read.programName;
    programs.set(programBindingKey(read.owner, name), address);
    if (name.startsWith("dacs1:listing:")) {
      listings.set(address, read.owner);
    } else if (name.startsWith("dacs1-revoked:")) {
      const listingHash = typeof read.data?.listingContentHash === "string"
        ? read.data.listingContentHash.toLowerCase()
        : null;
      if (listingHash) addRevocationCandidate(revocations, listingHash, address);
    } else if (name.startsWith("dacs5:bundle:seller:")) {
      sellerCopies.set(name.slice("dacs5:bundle:seller:".length), read.owner);
    } else if (name.startsWith("dacs5:bundle:")) {
      bundleOwners.set(name.slice("dacs5:bundle:".length), { address, owner: read.owner });
    }
  }

  // Attribute each discovered deal to its seller via the buyer-anchored agreement.
  const deals = new Map<string, RegisteredDeal & { sellerFromAgreement?: string }>();
  for (const [jobId, bundle] of bundleOwners) {
    const agreementAddress = programs.get(programBindingKey(bundle.owner, `dacs3:agreement:${jobId}`));
    const agreement = agreementAddress ? await readStorage(agreementAddress) : null;
    const seller =
      (agreement?.data as { seller?: string } | undefined)?.seller ??
      (sellerCopies.has(jobId) ? didOf(sellerCopies.get(jobId)!) : undefined);
    const rail =
      ((agreement?.data as { price?: { rail?: string } } | undefined)?.price?.rail) ?? "unknown";
    deals.set(jobId, {
      jobId,
      rail,
      buyerBundleRef: bundle.address,
      sellerBundleRef: sellerCopies.has(jobId)
        ? programs.get(programBindingKey(sellerCopies.get(jobId)!, `dacs5:bundle:seller:${jobId}`))
        : undefined,
      owners: { buyer: didOf(bundle.owner), seller: seller ?? "" },
      sellerFromAgreement: seller,
    });
  }

  return { listings, deals, programs, revocations, txsScanned: scanned, highestTxId, complete };
}
