export const LISTING_PUBLICATION_KEY = "dacs-register:pending-publication";

/** Name of the cross-tab lock that every writer of the saved record and Discard hold while they change it. */
export const LISTING_PUBLICATION_LOCK = "dacs-register:pending-publication";

/** The part of `navigator.locks` used here: runs `callback` while holding the named lock exclusively. */
export type ExclusiveLocks = {
  request<T>(name: string, callback: () => Promise<T> | T): Promise<T>;
};

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
    registration,
    stage: pending.stage,
    createdAt: Number(pending.createdAt),
  };
}

/** A valid saved record together with the exact stored text it was parsed from. */
export type SavedListingPublication = { pending: PendingListingPublication; raw: string };

export function readSavedListingPublication(storage: Pick<Storage, "getItem">): SavedListingPublication | null {
  try {
    const raw = storage.getItem(LISTING_PUBLICATION_KEY);
    const pending = raw ? parsePendingListingPublication(JSON.parse(raw)) : null;
    return raw && pending ? { pending, raw } : null;
  } catch {
    return null;
  }
}

export function readPendingListingPublication(storage: Pick<Storage, "getItem">): PendingListingPublication | null {
  return readSavedListingPublication(storage)?.pending ?? null;
}

/** Saves `pending` while holding the cross-tab lock, so it cannot land inside a Discard. Resolves false when the browser refuses the write. */
export async function writePendingListingPublication(
  storage: Pick<Storage, "setItem">,
  pending: PendingListingPublication,
  locks: ExclusiveLocks,
): Promise<boolean> {
  return locks.request(LISTING_PUBLICATION_LOCK, () => {
    try {
      storage.setItem(LISTING_PUBLICATION_KEY, JSON.stringify(pending));
      return true;
    } catch {
      return false;
    }
  });
}

export function clearPendingListingPublication(storage: Pick<Storage, "removeItem">): void {
  try { storage.removeItem(LISTING_PUBLICATION_KEY); } catch { /* best effort */ }
}

/** `discarded`: the record is gone. `changed`: the stored text is not the shown text (or none is stored) and was left alone. `failed`: the browser kept the record, or cross-tab locking is unavailable. */
export type DiscardOutcome = "discarded" | "changed" | "failed";

/**
 * Removes the saved record only while its stored text is exactly `shown.raw`, the text the user checked
 * and acknowledged. A record that another tab replaced or advanced since is left in place, including one
 * that only gained members this version does not read. The read, comparison and removal run under the
 * cross-tab lock that `writePendingListingPublication` also takes, because localStorage has no
 * compare-and-delete. Without a lock manager nothing is removed.
 */
export async function discardPendingListingPublication(
  storage: Pick<Storage, "getItem" | "removeItem">,
  shown: SavedListingPublication,
  locks: ExclusiveLocks | undefined,
): Promise<DiscardOutcome> {
  if (!locks) return "failed";
  return locks.request(LISTING_PUBLICATION_LOCK, (): DiscardOutcome => {
    let stored: string | null;
    try { stored = storage.getItem(LISTING_PUBLICATION_KEY); } catch { return "failed"; }
    if (stored !== shown.raw) return "changed";
    clearPendingListingPublication(storage);
    return readSavedListingPublication(storage) ? "failed" : "discarded";
  });
}
