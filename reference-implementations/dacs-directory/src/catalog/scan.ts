/**
 * Passive Demos discovery for a public catalog.
 *
 * The SDK's native history adapter is intentionally owner-scoped. A directory
 * has no owner list, so it walks the global confirmed transaction history but
 * applies the same trust boundary: only CREATE_STORAGE_PROGRAM records with an
 * explicit logicalAddress are current DACS anchors. programName is opaque.
 * Historical MVP records are retained through a separate compatibility path.
 */
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { classifyAnchor, type AnchorKind } from "@kynesyslabs/dacs/discovery";

import { programBindingKey } from "./store.js";
import type { RawAnchorObservation, RegisteredDeal } from "./types.js";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
const NATIVE_ADDRESS = /^stor-[0-9a-f]{40}$/;
const LOGICAL_BUNDLE = /^stor-[0-9a-f]{64}$/;

export interface ScannedArtifacts {
  listings: Map<string, string>;
  deals: Map<string, RegisteredDeal>;
  programs: Map<string, string>;
  revocations: Map<string, string[]>;
  anchors: Map<string, RawAnchorObservation>;
  txsScanned: number;
  highestTxId: number;
  complete: boolean;
}

interface StorageRead {
  success?: boolean;
  owner?: string;
  programName?: string;
  metadata?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

interface Candidate {
  nativeAddress: string;
  logicalAddress: string;
  owner: string;
  kind: AnchorKind;
  txId?: number;
  txHash?: string;
  blockNumber?: number;
  observedAt: number;
  compatibility: "current" | "legacy-mvp";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function recordContent(value: unknown): Record<string, unknown> | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function legacyLogicalAddress(programName: unknown): string | null {
  if (typeof programName !== "string") return null;
  return /^(?:dacs1:listing:|dacs1-revoked:|dacs5:bundle:)/.test(programName)
    ? programName
    : null;
}

function legacyKind(logicalAddress: string): AnchorKind {
  if (logicalAddress.startsWith("dacs1:listing:")) return "listing";
  if (logicalAddress.startsWith("dacs1-revoked:")) return "listing-revocation";
  if (logicalAddress.startsWith("dacs5:bundle:")) return "bundle";
  return "unknown";
}

/** Parse one confirmed create transaction without trusting prose/program names. */
export function parseCreateAnchorCandidate(value: unknown): Candidate | null {
  if (!isRecord(value) || value.status !== "confirmed") return null;
  if (!Number.isSafeInteger(value.blockNumber) || (value.blockNumber as number) < 0) return null;
  const content = recordContent(value.content);
  if (!content || content.type !== "storageProgram" || typeof content.from !== "string") return null;
  if (!Array.isArray(content.data) || content.data.length !== 2 || content.data[0] !== "storageProgram") return null;
  const payload = content.data[1];
  if (!isRecord(payload) || payload.operation !== "CREATE_STORAGE_PROGRAM") return null;
  if (typeof payload.storageAddress !== "string" || !NATIVE_ADDRESS.test(payload.storageAddress)) return null;
  if (content.to !== payload.storageAddress) return null;
  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  const camel = metadata?.logicalAddress;
  const snake = metadata?.logical_address;
  if (camel !== undefined && snake !== undefined && camel !== snake) {
    throw new Error(`conflicting logical metadata for ${payload.storageAddress}`);
  }
  const currentLogical = camel ?? snake;
  const current = typeof currentLogical === "string" && currentLogical.length > 0;
  const logicalAddress = current
    ? currentLogical
    : legacyLogicalAddress(payload.programName);
  if (!logicalAddress) return null;
  const kind = current ? classifyAnchor(logicalAddress) : legacyKind(logicalAddress);
  // Preserve future DACS logical namespaces even before this SDK classifies them.
  if (kind === "unknown" && !/^dacs[0-9-]+:/.test(logicalAddress) && !LOGICAL_BUNDLE.test(logicalAddress)) {
    return null;
  }
  return {
    nativeAddress: payload.storageAddress,
    logicalAddress,
    owner: content.from,
    kind,
    ...(typeof value.id === "number" ? { txId: value.id } : {}),
    ...(typeof value.hash === "string" ? { txHash: value.hash } : {}),
    blockNumber: value.blockNumber as number,
    observedAt: Date.now(),
    compatibility: current ? "current" : "legacy-mvp",
  };
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

/** Unauthenticated discovery call; every admitted row is still shape/finality checked. */
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

const didOf = (address: string): string =>
  `did:demos:agent:${address.replace(/^0x/, "").toLowerCase()}`;

export function addRevocationCandidate(
  revocations: Map<string, string[]>,
  listingHash: string,
  address: string,
): void {
  const candidates = revocations.get(listingHash) ?? [];
  if (!candidates.includes(address)) candidates.push(address);
  revocations.set(listingHash, candidates);
}

function bundleRole(data: Record<string, unknown>, logicalAddress: string): "buyer" | "seller" | null {
  if (data.anchoredByRole === "buyer" || data.anchoredByRole === "seller") return data.anchoredByRole;
  if (logicalAddress.startsWith("dacs5:bundle:seller:")) return "seller";
  if (logicalAddress.startsWith("dacs5:bundle:")) return "buyer";
  return null;
}

/** Rebuild projections solely from the append-only raw anchor journal. */
export function projectDiscoveredAnchors(anchors: Iterable<RawAnchorObservation>): Pick<
  ScannedArtifacts,
  "listings" | "deals" | "programs" | "revocations"
> {
  const listings = new Map<string, string>();
  const programs = new Map<string, string>();
  const revocations = new Map<string, string[]>();
  const bundleCopies = new Map<string, Partial<Record<"buyer" | "seller", RawAnchorObservation>>>();

  for (const anchor of anchors) {
    programs.set(programBindingKey(anchor.owner, anchor.logicalAddress), anchor.nativeAddress);
    if (anchor.readStatus !== "read" || !anchor.data) continue;
    if (anchor.kind === "listing") listings.set(anchor.nativeAddress, anchor.owner);
    if (anchor.kind === "listing-revocation") {
      const hash = typeof anchor.data.listingContentHash === "string"
        ? anchor.data.listingContentHash.toLowerCase()
        : null;
      if (hash) addRevocationCandidate(revocations, hash, anchor.nativeAddress);
    }
    if (anchor.kind === "bundle" && typeof anchor.data.jobId === "string") {
      const role = bundleRole(anchor.data, anchor.logicalAddress);
      if (!role) continue;
      const copies = bundleCopies.get(anchor.data.jobId) ?? {};
      copies[role] = anchor;
      bundleCopies.set(anchor.data.jobId, copies);
    }
  }

  const deals = new Map<string, RegisteredDeal>();
  for (const [jobId, copies] of bundleCopies) {
    const buyer = copies.buyer;
    if (!buyer?.data) continue;
    const parties = Array.isArray(buyer.data.parties)
      ? buyer.data.parties.filter(isRecord)
      : [];
    const claimFor = (role: string): string | undefined => {
      const value = parties.find((party) => party.role === role)?.primaryClaim;
      return typeof value === "string" ? value : undefined;
    };
    deals.set(jobId, {
      jobId,
      rail: "unknown",
      buyerBundleRef: buyer.nativeAddress,
      ...(copies.seller ? { sellerBundleRef: copies.seller.nativeAddress } : {}),
      owners: {
        buyer: claimFor("buyer") ?? didOf(buyer.owner),
        seller: claimFor("seller") ?? (copies.seller ? didOf(copies.seller.owner) : ""),
      },
    });
  }
  return { listings, deals, programs, revocations };
}

/**
 * Scan new global history and retry previously indeterminate anchor reads.
 * Transaction-page failures keep `complete=false`; artifact read failures are
 * journalled and retried without losing the transaction cursor.
 */
export async function scanChain(
  _demos: unknown,
  opts: {
    maxTxs?: number;
    sinceTxId?: number;
    retryAnchors?: RawAnchorObservation[];
  } = {},
): Promise<ScannedArtifacts> {
  const maxTxs = opts.maxTxs ?? 50_000;
  const since = opts.sinceTxId ?? 0;
  const candidates = new Map<string, Candidate>();
  for (const prior of opts.retryAnchors ?? []) {
    candidates.set(prior.nativeAddress, {
      nativeAddress: prior.nativeAddress,
      logicalAddress: prior.logicalAddress,
      owner: prior.owner,
      kind: prior.kind,
      ...(prior.txId === undefined ? {} : { txId: prior.txId }),
      ...(prior.txHash === undefined ? {} : { txHash: prior.txHash }),
      ...(prior.blockNumber === undefined ? {} : { blockNumber: prior.blockNumber }),
      observedAt: prior.observedAt,
      compatibility: prior.compatibility ?? "current",
    });
  }

  let scanned = 0;
  let highestTxId = since;
  let complete = false;
  let cursor: number | "latest" = "latest";
  const PAGE = 100;
  while (scanned < maxTxs) {
    let page: Array<Record<string, unknown>>;
    try {
      const raw = await nodeCall("getTransactions", { start: cursor, limit: PAGE });
      if (!Array.isArray(raw)) throw new Error("transaction page is not an array");
      page = raw.filter(isRecord);
    } catch {
      break;
    }
    if (page.length === 0) {
      complete = true;
      break;
    }
    const ids = page.map((tx) => tx.id).filter((id): id is number => typeof id === "number");
    highestTxId = Math.max(highestTxId, ...(ids.length ? ids : [highestTxId]));
    const fresh = page.filter((tx) => typeof tx.id !== "number" || tx.id > since);
    scanned += fresh.length;
    try {
      for (const tx of fresh) {
        const candidate = parseCreateAnchorCandidate(tx);
        if (!candidate) continue;
        const previous = candidates.get(candidate.nativeAddress);
        if (previous && previous.logicalAddress !== candidate.logicalAddress) {
          throw new Error(`conflicting logical metadata for ${candidate.nativeAddress}`);
        }
        candidates.set(candidate.nativeAddress, candidate);
      }
    } catch {
      complete = false;
      break;
    }
    if (ids.length === 0) break;
    const lowest = Math.min(...ids);
    if (lowest <= since + 1 || lowest <= 1) {
      complete = true;
      break;
    }
    cursor = lowest - 1;
  }

  const anchors = new Map<string, RawAnchorObservation>();
  const queue = [...candidates.values()];
  const concurrency = 12;
  for (let offset = 0; offset < queue.length; offset += concurrency) {
    await Promise.all(queue.slice(offset, offset + concurrency).map(async (candidate) => {
      const read = await readStorage(candidate.nativeAddress);
      if (!read?.success || !read.owner || !read.data) {
        anchors.set(candidate.nativeAddress, {
          ...candidate,
          readStatus: "indeterminate",
          readFailureReason: "storage record unavailable",
        });
        return;
      }
      const readLogical = read.metadata?.logicalAddress ?? read.metadata?.logical_address;
      if (typeof readLogical === "string" && readLogical !== candidate.logicalAddress) {
        anchors.set(candidate.nativeAddress, {
          ...candidate,
          readStatus: "indeterminate",
          readFailureReason: "storage logical metadata conflicts with confirmed create transaction",
        });
        return;
      }
      let hash: string | undefined;
      try {
        hash = contentHash(read.data);
      } catch {
        // The raw record remains useful for diagnostics, but never projects.
      }
      anchors.set(candidate.nativeAddress, {
        ...candidate,
        owner: read.owner,
        readStatus: hash ? "read" : "indeterminate",
        ...(hash ? { contentHash: hash, data: read.data } : { readFailureReason: "artifact is not canonical JSON" }),
      });
    }));
  }

  const projected = projectDiscoveredAnchors(anchors.values());
  return { ...projected, anchors, txsScanned: scanned, highestTxId, complete };
}
