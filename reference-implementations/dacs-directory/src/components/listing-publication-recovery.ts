export const LISTING_PUBLICATION_KEY = "dacs-register:pending-publication";

export type PendingPublicationStage = "broadcast-uncertain" | "confirming" | "registering";

export type PendingListingPublication = {
  version: 1;
  claim: string;
  listingId: string;
  listingVersion: number;
  anchorAddress: string;
  programName: string;
  contentHash: string;
  signedListing: Record<string, unknown>;
  transaction: Record<string, unknown> | null;
  transactionRef?: string;
  anchorReceipt?: Record<string, unknown>;
  registration: Record<string, unknown>;
  stage: PendingPublicationStage;
  createdAt: number;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function parsePendingListingPublication(value: unknown): PendingListingPublication | null {
  const pending = record(value);
  const signedListing = record(pending?.signedListing);
  const registration = record(pending?.registration);
  const transaction = pending?.transaction === null ? null : record(pending?.transaction);
  const anchorReceipt = pending?.anchorReceipt === undefined ? undefined : record(pending.anchorReceipt);
  if (
    pending?.version !== 1 ||
    typeof pending.claim !== "string" || !/^did:demos:agent:[0-9a-f]{64}$/.test(pending.claim) ||
    typeof pending.listingId !== "string" || !/^[a-z0-9-]{1,64}$/.test(pending.listingId) ||
    !Number.isSafeInteger(pending.listingVersion) || Number(pending.listingVersion) < 1 ||
    typeof pending.anchorAddress !== "string" || !/^stor-[0-9a-f]{40}$/.test(pending.anchorAddress) ||
    typeof pending.programName !== "string" || !pending.programName || pending.programName.length > 512 ||
    typeof pending.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(pending.contentHash) ||
    !signedListing ||
    !registration || registration.primaryClaim !== pending.claim ||
    !Array.isArray(registration.listingAnchors) || !registration.listingAnchors.includes(pending.anchorAddress) ||
    (pending.transaction !== null && !transaction) ||
    (pending.transactionRef !== undefined && (
      typeof pending.transactionRef !== "string" || !/^[0-9a-f]{64}$/.test(pending.transactionRef)
    )) ||
    (pending.anchorReceipt !== undefined && !anchorReceipt) ||
    (pending.stage !== "broadcast-uncertain" && pending.stage !== "confirming" && pending.stage !== "registering") ||
    !Number.isSafeInteger(pending.createdAt) || Number(pending.createdAt) <= 0
  ) return null;

  return {
    version: 1,
    claim: pending.claim,
    listingId: pending.listingId,
    listingVersion: Number(pending.listingVersion),
    anchorAddress: pending.anchorAddress,
    programName: pending.programName,
    contentHash: pending.contentHash,
    signedListing,
    transaction,
    ...(typeof pending.transactionRef === "string" ? { transactionRef: pending.transactionRef } : {}),
    ...(anchorReceipt ? { anchorReceipt } : {}),
    registration,
    stage: pending.stage,
    createdAt: Number(pending.createdAt),
  };
}

export function readPendingListingPublication(storage: Pick<Storage, "getItem">): PendingListingPublication | null {
  try {
    const raw = storage.getItem(LISTING_PUBLICATION_KEY);
    return raw ? parsePendingListingPublication(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writePendingListingPublication(
  storage: Pick<Storage, "setItem">,
  pending: PendingListingPublication,
): boolean {
  try {
    storage.setItem(LISTING_PUBLICATION_KEY, JSON.stringify(pending));
    return true;
  } catch {
    return false;
  }
}

export function clearPendingListingPublication(storage: Pick<Storage, "removeItem">): void {
  try { storage.removeItem(LISTING_PUBLICATION_KEY); } catch { /* best effort */ }
}
