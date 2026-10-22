import { canonicalize, contentHash, sha256Hex } from "./canonical.js";
import { demosSignedTransactionProofHash } from "../sdkDemosWriteEvidence.js";

import { readAnchorRecord } from "./chain.js";
import { nodeBuildRejection, pinnedChainIdentity, reportedNodeBuild } from "./nodeDeployment.js";
import { storageResponseJson } from "./artifactLimits.js";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
const PAGE_SIZE = 100;
const MAX_TRANSACTIONS = 5_000;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const parsedRecord = (value: unknown): Record<string, unknown> | null => {
  if (typeof value !== "string") return record(value);
  try { return record(JSON.parse(value)); } catch { return null; }
};

async function nodeCall(message: string, data: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${RPC}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: signal ?? AbortSignal.timeout(15_000),
    body: JSON.stringify({
      method: "nodeCall",
      params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data, extra: "" }],
    }),
  });
  if (!response.ok) throw new Error(`${message} transport failed`);
  const body = await storageResponseJson(response) as { result?: number; response?: unknown };
  if (body.result !== 200) throw new Error(`${message} returned ${String(body.result)}`);
  return body.response;
}

/**
 * Mirrors the pinned SDK's DemosAdapter.resolveChainIdentity: deployed nodes
 * (node2 0.9.8 among them) answer block zero with `result: 400` / `"error"`,
 * so a failed or hashless genesis read falls back to block one's predecessor.
 */
async function chainIdentity(signal?: AbortSignal): Promise<string> {
  const genesis = record(await nodeCall("getBlockByNumber", { blockNumber: 0 }, signal).catch(() => null));
  const genesisHash = typeof genesis?.hash === "string" ? genesis.hash.trim().toLowerCase() : "";
  const genesisNumber = genesis?.number ?? genesis?.id;
  if (/^[0-9a-f]{64}$/.test(genesisHash) && (genesisNumber === undefined || genesisNumber === 0)) return genesisHash;
  const first = record(await nodeCall("getBlockByNumber", { blockNumber: 1 }, signal));
  const firstContent = parsedRecord(first?.content);
  const previousHash = typeof firstContent?.previousHash === "string"
    ? firstContent.previousHash.trim().toLowerCase()
    : "";
  if (
    !first || first.status !== "confirmed" || first.number !== 1 ||
    typeof first.hash !== "string" || !/^[0-9a-f]{64}$/i.test(first.hash.trim()) || !/^[0-9a-f]{64}$/.test(previousHash)
  ) {
    throw new Error("Demos genesis block has no stable chain identity");
  }
  return previousHash;
}

/** node2's getTransactions rows carry `content` and `signature` as JSON strings; getTxByHash carries objects. */
function normalizedTransaction(tx: Record<string, unknown>): Record<string, unknown> {
  const signature = typeof tx.signature === "string" ? parsedRecord(tx.signature) : null;
  return {
    ...tx,
    content: parsedRecord(tx.content) ?? tx.content,
    ...(signature ? { signature } : {}),
  };
}

/** The SDK re-reads a known write by hash; the newest-history scan is only a fallback. */
async function writeByHash(
  anchorAddress: string,
  listingContentHash: string,
  expectedTxRef: string,
): Promise<Record<string, unknown> | null> {
  const txRef = expectedTxRef.toLowerCase();
  const tx = record(await nodeCall("getTxByHash", { hash: txRef }).catch(() => null));
  const content = parsedRecord(tx?.content);
  if (!tx || !content) return null;
  const { storageWriteCandidate } = await import("./scan.js");
  const candidate = storageWriteCandidate({ ...tx, type: tx.type ?? content.type, to: tx.to ?? content.to, content });
  return candidate?.locator === anchorAddress &&
    candidate.contentHash === listingContentHash &&
    candidate.transactionHash === txRef
    ? normalizedTransaction(tx)
    : null;
}

async function findCanonicalWrite(
  anchorAddress: string,
  listingContentHash: string,
  expectedTxRef?: string,
): Promise<Record<string, unknown> | null> {
  if (expectedTxRef) {
    return writeByHash(anchorAddress, listingContentHash, expectedTxRef);
  }
  const { storageWriteCandidate } = await import("./scan.js");
  let cursor: number | "latest" = "latest";
  let scanned = 0;
  while (scanned < MAX_TRANSACTIONS) {
    const page = await nodeCall("getTransactions", {
      start: cursor,
      limit: Math.min(PAGE_SIZE, MAX_TRANSACTIONS - scanned),
    });
    if (!Array.isArray(page) || page.length === 0) return null;
    for (const raw of page) {
      const tx = record(raw);
      const candidate = storageWriteCandidate(tx);
      if (
        tx && candidate?.locator === anchorAddress &&
        candidate.contentHash === listingContentHash &&
        (!expectedTxRef || candidate.transactionHash === expectedTxRef.toLowerCase())
      ) {
        return normalizedTransaction(tx);
      }
    }
    scanned += page.length;
    const ids = page.map((item) => record(item)?.id)
      .filter((id): id is number => Number.isSafeInteger(id) && Number(id) >= 0);
    if (ids.length === 0) throw new Error("transaction history page has no valid cursor");
    const lowest = Math.min(...ids);
    if (lowest <= 1) return null;
    cursor = lowest - 1;
  }
  throw new Error(`finality lookup exceeded ${MAX_TRANSACTIONS} transactions`);
}

/**
 * The configured node's deployment against this release's pin: its reported
 * build, then the chain it serves. The node reports both itself, so this
 * detects drift; it does not authenticate the node. Throws when the node
 * cannot be read.
 */
export async function pinnedNodeDeployment(): Promise<
  | { ok: true; build: string; chainIdentity: string }
  | { ok: false; reason: string }
> {
  const networkInfo = await nodeCall("getNetworkInfo", {});
  const buildRejection = nodeBuildRejection(networkInfo);
  if (buildRejection) return { ok: false, reason: buildRejection };
  const servedChain = await chainIdentity();
  if (servedChain !== pinnedChainIdentity()) {
    return { ok: false, reason: `Demos node serves chain ${servedChain}, not the pinned chain` };
  }
  return { ok: true, build: reportedNodeBuild(networkInfo) ?? "", chainIdentity: servedChain };
}

/** Catalog refreshes require the configured chain; self-reported build drift is diagnostic. */
export async function catalogNodeDeployment(signal?: AbortSignal): Promise<
  | { ok: true; build: string | null; chainIdentity: string; warning: string | null }
  | { ok: false; reason: string }
> {
  const servedChain = await chainIdentity(signal);
  if (servedChain !== pinnedChainIdentity()) {
    return { ok: false, reason: `Demos node serves chain ${servedChain}, not the pinned chain` };
  }
  const networkInfo = await nodeCall("getNetworkInfo", {}, signal).catch(() => null);
  return {
    ok: true,
    build: reportedNodeBuild(networkInfo),
    chainIdentity: servedChain,
    warning: nodeBuildRejection(networkInfo),
  };
}

/**
 * What the configured node reports, in the form DEMOS_NODE_BUILDS and
 * DEMOS_CHAIN_IDENTITY take, with the pin's verdict. For operators deciding
 * whether to re-pin (`npm run check:node-deployment`); reviewing the reported
 * chain and build is still the operator's call. Throws when the node cannot be read.
 */
export async function observeNodeDeployment(): Promise<{
  build: string | null;
  chainIdentity: string;
  pin: Awaited<ReturnType<typeof pinnedNodeDeployment>>;
}> {
  const networkInfo = await nodeCall("getNetworkInfo", {});
  const servedChain = await chainIdentity();
  return { build: reportedNodeBuild(networkInfo), chainIdentity: servedChain, pin: await pinnedNodeDeployment() };
}

/**
 * What the configured, pinned node reports about one listing write. None of it
 * is authenticated: Demos consensus (validator signatures, eligible pool,
 * quorum) is not verified, and on Demos a valid `included` write is also
 * `finalized` (DEMOS-MAPPING SR-2). So this is never issued as a CORE §5.1
 * AnchorReceipt and never satisfies DACS-1 LP-1.
 */
export interface ListingAnchorNodeObservation {
  chainIdentity: string;
  nodeBuild: string;
  logicalAddress: string;
  nativeAddress: string;
  contentHash: string;
  writer: string;
  transactionRef: string;
  signedTransactionHash: string;
  blockNumber: number;
  blockHash: string;
  blockTimestamp: number;
  validationDataHash: string;
  nativeRead: { owner: string; programName: string; valueHash: string; metadataHash: string };
}

export type ListingAnchorInclusionResult =
  | { status: "pending"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "included"; authenticated: false; observation: ListingAnchorNodeObservation };

/**
 * Observe a listing write through the canonical transaction, the block the
 * configured node reports as confirmed, and exact native readback. Read
 * visibility alone never returns `included`, and the result is an
 * unauthenticated node observation, not a receipt (see validatorSignatureShape).
 */
export async function observeListingAnchorInclusion(input: {
  anchorAddress: string;
  logicalAddress: string;
  programName: string;
  listingContentHash: string;
  sellerClaim: string;
  transactionRef?: string;
}): Promise<ListingAnchorInclusionResult> {
  try {
    const anchored = await readAnchorRecord(input.anchorAddress);
    if (!anchored) return { status: "pending", reason: "native anchor is not readable" };
    if (
      anchored.programName !== input.programName ||
      anchored.storageAddress !== undefined && anchored.storageAddress !== input.anchorAddress
    ) return { status: "rejected", reason: "native anchor coordinates do not match" };
    const tx = await findCanonicalWrite(
      input.anchorAddress,
      input.listingContentHash,
      input.transactionRef,
    );
    if (!tx) return { status: "pending", reason: "canonical transaction is not included" };
    const txRef = typeof tx.hash === "string" ? tx.hash.toLowerCase() : "";
    const blockNumber = Number(tx.blockNumber);
    const txContent = record(tx.content);
    if (!/^[0-9a-f]{64}$/.test(txRef) || !Number.isSafeInteger(blockNumber) || blockNumber < 0 || !txContent) {
      return { status: "rejected", reason: "canonical transaction is malformed" };
    }
    const block = record(await nodeCall("getBlockByNumber", { blockNumber }));
    const blockContent = parsedRecord(block?.content);
    const orderedTransactions = Array.isArray(blockContent?.ordered_transactions)
      ? blockContent.ordered_transactions
      : [];
    const rawTimestamp = blockContent?.timestamp;
    const blockTimestamp = Number.isSafeInteger(rawTimestamp) && Number(rawTimestamp) >= 0
      ? Number(rawTimestamp) < 100_000_000_000 ? Number(rawTimestamp) * 1_000 : Number(rawTimestamp)
      : NaN;
    if (
      !block || block.status !== "confirmed" || block.number !== blockNumber ||
      typeof block.hash !== "string" || !/^[0-9a-f]{64}$/.test(block.hash) ||
      !Number.isSafeInteger(blockTimestamp) || !orderedTransactions.includes(txRef) ||
      !validatorSignatureShape(block.validation_data)
    ) return { status: "pending", reason: "canonical block is not confirmed by the configured node" };

    // Only the pinned deployment's report is passed on.
    const deployment = await pinnedNodeDeployment();
    if (!deployment.ok) return { status: "rejected", reason: deployment.reason };

    const payload = Array.isArray(txContent.data) ? record(txContent.data[1]) : null;
    const transactionMetadata = record(payload?.metadata);
    const metadata = anchored.metadata;
    const owner = typeof anchored.owner === "string" ? anchored.owner : "";
    const nativeValueHash = sha256Hex(canonicalize(anchored.data));
    if (
      contentHash(anchored.data) !== input.listingContentHash ||
      !metadata || !transactionMetadata || !sameCanonical(metadata, transactionMetadata) ||
      metadata?.logicalAddress !== input.logicalAddress ||
      metadata.contentHash !== input.listingContentHash ||
      metadata.envelopeHash !== nativeValueHash
    ) return { status: "rejected", reason: "native listing metadata does not bind the signed artifact" };
    return {
      status: "included",
      authenticated: false,
      observation: {
        chainIdentity: deployment.chainIdentity,
        nodeBuild: deployment.build,
        logicalAddress: input.logicalAddress,
        nativeAddress: input.anchorAddress,
        contentHash: input.listingContentHash,
        writer: input.sellerClaim,
        transactionRef: txRef,
        signedTransactionHash: demosSignedTransactionProofHash(tx),
        blockNumber,
        blockHash: block.hash,
        blockTimestamp,
        validationDataHash: sha256Hex(canonicalize(block.validation_data)),
        nativeRead: {
          owner,
          programName: input.programName,
          valueHash: nativeValueHash,
          metadataHash: sha256Hex(canonicalize(metadata)),
        },
      },
    };
  } catch (error) {
    return {
      status: "pending",
      reason: error instanceof Error ? error.message : "inclusion observation failed",
    };
  }
}

/**
 * The node's `validation_data` shape: a non-empty map from validator public
 * key to Ed25519 block signature. This refuses placeholder or arbitrary
 * objects, but it is a shape check only. The signatures, the eligible
 * validator pool and the 2/3+1 quorum are not verified here, nor by the
 * pinned SDK's own Demos adapter, which is why no receipt is issued.
 */
function validatorSignatureShape(value: unknown): boolean {
  const signatures = record(record(value)?.signatures);
  const entries = signatures ? Object.entries(signatures) : [];
  return entries.length > 0 && entries.every(([key, signature]) =>
    /^0x[0-9a-f]{64}$/i.test(key) && typeof signature === "string" && /^0x[0-9a-f]{128}$/i.test(signature));
}

function sameCanonical(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try { return canonicalize(left) === canonicalize(right); } catch { return false; }
}
