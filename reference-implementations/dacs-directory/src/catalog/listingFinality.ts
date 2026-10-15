import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  assertDemosWriteEvidence,
  demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt,
  type DemosWriteEvidence,
} from "../sdkDemosWriteEvidence.js";
import { isAnchorReceipt, type AnchorReceipt } from "@kynesyslabs/dacs/artifacts";

import { readAnchorRecord } from "./chain.js";
import { nodeBuildRejection, pinnedChainIdentity } from "./nodeDeployment.js";
import { storageWriteCandidate } from "./scan.js";

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

async function nodeCall(message: string, data: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${RPC}/`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      method: "nodeCall",
      params: [{ type: "nodeCall", message, sender: null, receiver: null, timestamp: null, data, extra: "" }],
    }),
  });
  if (!response.ok) throw new Error(`${message} transport failed`);
  const body = await response.json() as { result?: number; response?: unknown };
  if (body.result !== 200) throw new Error(`${message} returned ${String(body.result)}`);
  return body.response;
}

/**
 * Mirrors the pinned SDK's DemosAdapter.resolveChainIdentity: deployed nodes
 * (node2 0.9.8 among them) answer block zero with `result: 400` / `"error"`,
 * so a failed or hashless genesis read falls back to block one's predecessor.
 */
async function chainIdentity(): Promise<string> {
  const genesis = record(await nodeCall("getBlockByNumber", { blockNumber: 0 }).catch(() => null));
  const genesisHash = typeof genesis?.hash === "string" ? genesis.hash.trim().toLowerCase() : "";
  const genesisNumber = genesis?.number ?? genesis?.id;
  if (genesisHash && (genesisNumber === undefined || genesisNumber === 0)) return genesisHash;
  const first = record(await nodeCall("getBlockByNumber", { blockNumber: 1 }));
  const firstContent = parsedRecord(first?.content);
  const previousHash = typeof firstContent?.previousHash === "string"
    ? firstContent.previousHash.trim().toLowerCase()
    : "";
  if (
    !first || first.status !== "confirmed" || first.number !== 1 ||
    typeof first.hash !== "string" || !first.hash.trim() || !previousHash
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
    const known = await writeByHash(anchorAddress, listingContentHash, expectedTxRef);
    if (known) return known;
  }
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
 * Inclusion is all the Directory can establish: it does not verify Demos
 * consensus (validator signatures, eligible pool, quorum), so it never labels
 * a write final. Verified Demos finality needs SDK support.
 */
export type ListingAnchorInclusionResult =
  | { status: "pending"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "included"; finality: "not-verified"; receipt: AnchorReceipt };

export interface ExpectedListingAnchorWrite {
  anchorAddress: string;
  logicalAddress: string;
  listingContentHash: string;
  sellerClaim: string;
  transactionRef: string;
}

/**
 * Registration admits a Listing only on a receipt that passes the SDK's CORE
 * §5.1 AnchorReceipt gate, records an established included write, and binds
 * this exact listing write. A `finalized` receipt is refused: this flow cannot
 * verify Demos finality, so such a claim would be unverified. Returns the
 * rejection reason, or null to admit.
 */
export function listingAnchorReceiptRejection(
  receipt: unknown,
  expected: ExpectedListingAnchorWrite,
): string | null {
  if (!isAnchorReceipt(receipt)) return "anchor receipt is not a CORE §5.1 AnchorReceipt";
  if (receipt.state !== "included" || receipt.observationDisposition !== "established") {
    return "anchor receipt does not establish an included write";
  }
  if (
    receipt.logicalAddress !== expected.logicalAddress ||
    receipt.nativeAddress !== expected.anchorAddress ||
    receipt.contentHash !== expected.listingContentHash ||
    receipt.writer !== expected.sellerClaim ||
    receipt.transactionRef.value !== expected.transactionRef
  ) return "anchor receipt does not bind this listing write";
  return null;
}

/**
 * Establish an `included` Demos AnchorReceipt from the canonical transaction,
 * the block the configured node reports as confirmed, and exact native
 * readback. Read visibility alone never returns `included`, and nothing here
 * returns `finalized`: consensus signatures are not verified (see
 * validatorSignatureShape).
 */
export async function includedListingAnchorReceipt(input: {
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

    // Only the pinned deployment's report becomes a portable receipt.
    const buildRejection = nodeBuildRejection(await nodeCall("getNetworkInfo", {}));
    if (buildRejection) return { status: "rejected", reason: buildRejection };
    const servedChain = await chainIdentity();
    if (servedChain !== pinnedChainIdentity()) {
      return { status: "rejected", reason: `Demos node serves chain ${servedChain}, not the pinned chain` };
    }

    const payload = Array.isArray(txContent.data) ? record(txContent.data[1]) : null;
    const transactionMetadata = record(payload?.metadata);
    const metadata = anchored.metadata;
    const owner = typeof anchored.owner === "string" ? anchored.owner : "";
    const nonce = Number(txContent.nonce);
    const nativeValueHash = sha256Hex(canonicalize(anchored.data));
    const finalityProof = canonicalize(block.validation_data);
    const evidence: DemosWriteEvidence = {
      evidenceVersion: "1",
      chainIdentity: servedChain,
      writer: owner,
      logicalName: input.logicalAddress,
      nativeAddress: input.anchorAddress,
      operation: payload?.operation === "WRITE_STORAGE" ? "update" : "create",
      nonce,
      transactionRef: txRef,
      signedTransaction: canonicalize(tx),
      signedTransactionHash: demosSignedTransactionProofHash(tx),
      blockNumber,
      blockHash: block.hash,
      blockTimestamp,
      finalityProof,
      finalityProofHash: sha256Hex(finalityProof),
      nativeRead: {
        owner,
        programName: input.programName,
        valueHash: nativeValueHash,
        ...(metadata ? { metadataHash: sha256Hex(canonicalize(metadata)) } : {}),
        observedAt: Date.now(),
      },
    };
    if (
      contentHash(anchored.data) !== input.listingContentHash ||
      !metadata || !transactionMetadata || !sameCanonical(metadata, transactionMetadata) ||
      metadata?.logicalAddress !== input.logicalAddress ||
      metadata.contentHash !== input.listingContentHash ||
      metadata.envelopeHash !== nativeValueHash
    ) return { status: "rejected", reason: "native listing metadata does not bind the signed artifact" };
    assertDemosWriteEvidence(evidence);
    // The SDK's portable form always states `finalized`; without consensus
    // verification the Directory can establish only inclusion (CORE §5.1).
    const receipt: AnchorReceipt = {
      ...demosWriteEvidenceToAnchorReceipt({
        logicalAddress: input.logicalAddress,
        contentHash: input.listingContentHash,
        writer: input.sellerClaim,
        evidence,
      }),
      state: "included",
    };
    const rejection = listingAnchorReceiptRejection(receipt, { ...input, transactionRef: txRef });
    return rejection
      ? { status: "rejected", reason: rejection }
      : { status: "included", finality: "not-verified", receipt };
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
 * pinned SDK's own Demos adapter, which is why receipts state `included`.
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
