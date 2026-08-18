import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import {
  assertDemosWriteEvidence,
  demosSignedTransactionProofHash,
  demosWriteEvidenceToAnchorReceipt,
  type DemosWriteEvidence,
} from "../sdkDemosWriteEvidence.js";
import type { AnchorReceipt } from "@kynesyslabs/dacs/artifacts";

import { readAnchorRecord } from "./chain.js";
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

async function chainIdentity(): Promise<string> {
  const genesis = record(await nodeCall("getBlockByNumber", { blockNumber: 0 }));
  const genesisHash = typeof genesis?.hash === "string" ? genesis.hash.trim().toLowerCase() : "";
  if (genesisHash && (genesis?.number === undefined || genesis.number === 0)) return genesisHash;
  const first = record(await nodeCall("getBlockByNumber", { blockNumber: 1 }));
  const firstContent = parsedRecord(first?.content);
  const previousHash = typeof firstContent?.previousHash === "string"
    ? firstContent.previousHash.trim().toLowerCase()
    : "";
  if (!first || first.status !== "confirmed" || first.number !== 1 || !previousHash) {
    throw new Error("Demos genesis block has no stable chain identity");
  }
  return previousHash;
}

async function findCanonicalWrite(
  anchorAddress: string,
  listingContentHash: string,
  expectedTxRef?: string,
): Promise<Record<string, unknown> | null> {
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
        return { ...tx, content: parsedRecord(tx.content) ?? tx.content };
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

export type FinalizedListingAnchorResult =
  | { status: "pending"; reason: string }
  | { status: "rejected"; reason: string }
  | { status: "finalized"; receipt: AnchorReceipt };

/**
 * Establish a portable finalized Demos AnchorReceipt from canonical transaction,
 * BFT-confirmed block, and exact native readback. Read visibility alone never
 * returns `finalized`.
 */
export async function finalizedListingAnchorReceipt(input: {
  anchorAddress: string;
  logicalAddress: string;
  programName: string;
  listingContentHash: string;
  sellerClaim: string;
  transactionRef?: string;
}): Promise<FinalizedListingAnchorResult> {
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
    if (!tx) return { status: "pending", reason: "canonical transaction is not finalized" };
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
      typeof block.hash !== "string" || !block.hash ||
      !Number.isSafeInteger(blockTimestamp) || !orderedTransactions.includes(txRef) ||
      block.validation_data === undefined
    ) return { status: "pending", reason: "canonical block is not BFT-confirmed" };

    const payload = Array.isArray(txContent.data) ? record(txContent.data[1]) : null;
    const transactionMetadata = record(payload?.metadata);
    const metadata = anchored.metadata;
    const owner = typeof anchored.owner === "string" ? anchored.owner : "";
    const nonce = Number(txContent.nonce);
    const nativeValueHash = sha256Hex(canonicalize(anchored.data));
    const finalityProof = canonicalize(block.validation_data);
    const evidence: DemosWriteEvidence = {
      evidenceVersion: "1",
      chainIdentity: await chainIdentity(),
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
    return {
      status: "finalized",
      receipt: demosWriteEvidenceToAnchorReceipt({
        logicalAddress: input.logicalAddress,
        contentHash: input.listingContentHash,
        writer: input.sellerClaim,
        evidence,
      }),
    };
  } catch (error) {
    return {
      status: "pending",
      reason: error instanceof Error ? error.message : "finality observation failed",
    };
  }
}

function sameCanonical(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  try { return canonicalize(left) === canonicalize(right); } catch { return false; }
}
