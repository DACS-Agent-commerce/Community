/** Transactional index repository backed by SQLite, with one-time JSON migration. */
import { boundedJson } from "./artifactLimits.js";
import { canonicalProgramOwner, normalizeScanState } from "./scanState.js";
import { deriveAnchorAddress } from "./chain.js";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Catalog, ListingSummary, Registration, RevocationBinding, ScanState } from "./types.js";
import { bindsListingTuple, normalizeSubmittedDomain, revocationBindingKey, type WithdrawalProvenance } from "./wellknown.js";
import { sellerIdentity } from "./discovery.js";
import { deriveSellerReputation } from "./reputation.js";
import { DIRECTORY_TRANSACTION_READINESS } from "./inspection.js";
import {
  LISTING_REJECTION_MESSAGES,
  LISTING_REJECTION_GUIDANCE,
  type ListingDiagnosticCoordinates,
  type ListingRejectionCode,
} from "./listingAdmission.js";

export type { ListingRejectionCode } from "./listingAdmission.js";

export const DATA_DIR = process.env.DACS_DIRECTORY_DATA ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "directory.sqlite");
const LEGACY = {
  catalog: join(DATA_DIR, "catalog.json"),
  registrations: join(DATA_DIR, "registrations.json"),
  scanState: join(DATA_DIR, "scan-state.json"),
  domains: join(DATA_DIR, "domains.json"),
  fixtures: join(DATA_DIR, "fixtures.json"),
};

export type FixtureSeed = "counterparty-evidence";
const FIXTURE_SEEDS = new Set<FixtureSeed>(["counterparty-evidence"]);

let db: Database.Database;
try {
  mkdirSync(DATA_DIR, { recursive: true });
  // The constructor timeout installs SQLite's busy handler before any PRAGMA
  // or schema work. Setting busy_timeout only after journal_mode is too late:
  // two fresh processes can otherwise race while the database enters WAL mode.
  db = new Database(DB_PATH, { timeout: 10_000 });
} catch (error) {
  throw new Error(
    `DACS directory storage could not be opened at ${DB_PATH}; configure DACS_DIRECTORY_DATA to a writable persistent volume`,
    { cause: error },
  );
}
db.pragma("busy_timeout = 10000");
// SQLite can return SQLITE_BUSY immediately while changing journal mode even
// with a busy handler installed. Retry that one-time transition explicitly so
// concurrent workers starting against a fresh database converge on WAL.
const walDeadline = Date.now() + 10_000;
const walRetrySignal = new Int32Array(new SharedArrayBuffer(4));
for (;;) {
  try {
    db.pragma("journal_mode = WAL");
    break;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (!code.startsWith("SQLITE_BUSY") || Date.now() >= walDeadline) throw error;
    Atomics.wait(walRetrySignal, 0, 0, 25);
  }
}
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS leases (
    name TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS listing_preparations (
    chain_identity TEXT NOT NULL,
    logical_address TEXT NOT NULL,
    anchor_address TEXT NOT NULL,
    transaction_json TEXT NOT NULL,
    PRIMARY KEY(chain_identity, logical_address)
  );
  CREATE TABLE IF NOT EXISTS artifacts (
    locator TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    profile TEXT NOT NULL,
    owner TEXT,
    content_hash TEXT,
    observed_at INTEGER NOT NULL,
    anchor_time INTEGER,
    status TEXT NOT NULL DEFAULT 'observed',
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    data_json TEXT
  );
  CREATE INDEX IF NOT EXISTS artifacts_retry_idx ON artifacts(status, next_retry_at);
  CREATE INDEX IF NOT EXISTS artifacts_hash_idx ON artifacts(content_hash);
  CREATE TABLE IF NOT EXISTS scan_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    from_tx INTEGER NOT NULL,
    to_tx INTEGER,
    chain_tip INTEGER,
    txs_scanned INTEGER NOT NULL DEFAULT 0,
    artifacts_observed INTEGER NOT NULL DEFAULT 0,
    rejected INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS dead_letters (
    locator TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    error_code TEXT NOT NULL,
    error_message TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS dead_letters_recent_idx ON dead_letters(last_seen_at DESC, locator);
  CREATE TABLE IF NOT EXISTS artifact_failure_history (
    locator TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    observations INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS artifact_failure_history_age_idx
    ON artifact_failure_history(last_seen_at ASC, locator);
  CREATE TABLE IF NOT EXISTS listing_rejections (
    locator TEXT NOT NULL,
    registration_claim TEXT NOT NULL,
    reason_code TEXT NOT NULL,
    listing_id TEXT,
    listing_version INTEGER,
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(locator, registration_claim)
  );
  CREATE INDEX IF NOT EXISTS listing_rejections_recent_idx
    ON listing_rejections(last_seen_at DESC, locator);
  CREATE TABLE IF NOT EXISTS revocation_candidates (
    listing_hash TEXT NOT NULL,
    locator TEXT NOT NULL,
    owner TEXT,
    content_hash TEXT,
    seq INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY(listing_hash, locator)
  );
  CREATE TABLE IF NOT EXISTS revocation_candidate_retries (
    listing_hash TEXT NOT NULL,
    locator TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    retry_after INTEGER NOT NULL,
    PRIMARY KEY(listing_hash, locator),
    FOREIGN KEY(listing_hash, locator) REFERENCES revocation_candidates(listing_hash, locator) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS revocation_candidates_seq_idx ON revocation_candidates(seq);
  CREATE INDEX IF NOT EXISTS revocation_candidates_pending_idx
    ON revocation_candidates(listing_hash, seq) WHERE state = 'pending';
  CREATE INDEX IF NOT EXISTS revocation_candidates_owner_idx
    ON revocation_candidates(listing_hash, owner, seq) WHERE state = 'pending';
`);

// BEGIN IMMEDIATE serializes the read-then-DDL upgrade across app/indexer
// processes. A deferred transaction can let both readers observe the old
// schema and then fail one upgrader immediately with SQLITE_BUSY.
db.transaction(() => {
  const listingRejectionColumns = new Set(
    (db.prepare("PRAGMA table_info(listing_rejections)").all() as Array<{ name: string }>).map((column) => column.name),
  );
  if (!listingRejectionColumns.has("listing_id")) {
    db.exec("ALTER TABLE listing_rejections ADD COLUMN listing_id TEXT");
  }
  if (!listingRejectionColumns.has("listing_version")) {
    db.exec("ALTER TABLE listing_rejections ADD COLUMN listing_version INTEGER");
  }
  if (!listingRejectionColumns.has("public_notice")) {
    // Earlier coordinates were not authenticated; never promote them to notices.
    db.exec("ALTER TABLE listing_rejections ADD COLUMN public_notice INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE listing_rejections SET listing_id = NULL, listing_version = NULL");
  }
}).immediate();

// Add internal omission counters without changing the public diagnostic projection.
db.transaction(() => {
  const columns = db.pragma("table_info(scan_runs)") as Array<{ name: string }>;
  for (const column of ["omitted_sellers", "omitted_bindings", "omitted_deals"]) {
    if (!columns.some((entry) => entry.name === column)) db.exec(`ALTER TABLE scan_runs ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0`);
  }
}).immediate();

/** Retry reads per pass. Transient failures are returned first. */
export const RETRY_READS_PER_PASS = 100;
/** Rejected retries per pass: reserved whenever any are due, and never more than this. */
export const REJECTED_RETRY_READS_PER_PASS = 20;
/** Ceiling on scheduled rejected retries. Overflow waits in arrival order and rotates in. */
export const MAX_ACTIVE_REJECTED_RETRIES = 1_000;
const REJECTED_ACTIVE = "rejection_count > 0 AND deferred_at IS NULL AND status IN ('retry','dead-letter')";

// Rejected content and transient read failures are counted and scheduled as separate classes.
db.transaction(() => {
  const columns = db.pragma("table_info(artifacts)") as Array<{ name: string }>;
  if (!columns.some((entry) => entry.name === "rejection_count")) {
    db.exec("ALTER TABLE artifacts ADD COLUMN rejection_count INTEGER NOT NULL DEFAULT 0");
    // Rows written with one shared counter: a rejected row's count was its rejections.
    db.prepare(`UPDATE artifacts SET rejection_count=MAX(retry_count,1), retry_count=0, status='retry',
      next_retry_at=COALESCE(next_retry_at,0) WHERE error_code='ARTIFACT_REJECTED'`).run();
    db.prepare("DELETE FROM dead_letters WHERE error_code='ARTIFACT_REJECTED'").run();
  }
  if (!columns.some((entry) => entry.name === "deferred_at")) db.exec("ALTER TABLE artifacts ADD COLUMN deferred_at INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS artifacts_rejected_retry_idx ON artifacts(deferred_at, next_retry_at) WHERE rejection_count > 0");
  // At most MAX_ACTIVE_REJECTED_RETRIES stay scheduled, including rows migrated above:
  // the earliest due stay, and the rest wait for a slot, returning in due order.
  // Idempotent, so it also runs on every start.
  const excess = (db.prepare(`SELECT COUNT(*) count FROM artifacts WHERE ${REJECTED_ACTIVE}`).get() as { count: number }).count -
    MAX_ACTIVE_REJECTED_RETRIES;
  if (excess > 0) {
    const deferred = (db.prepare(`SELECT locator FROM artifacts WHERE ${REJECTED_ACTIVE}
      ORDER BY COALESCE(next_retry_at,0) DESC, locator DESC LIMIT ?`).all(excess) as Array<{ locator: string }>).reverse();
    const defer = db.prepare("UPDATE artifacts SET deferred_at=?, next_retry_at=NULL WHERE locator=?");
    const start = Date.now() - deferred.length;
    for (const [index, row] of deferred.entries()) defer.run(start + index, row.locator);
  }
}).immediate();

export function throwIfInfrastructureError(error: unknown): void {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  if (code.startsWith("SQLITE_") || ["EIO", "ENOSPC", "EROFS", "EACCES"].includes(code)) throw error;
}

const readLegacy = <T>(path: string, fallback: T): T =>
  existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as T : fallback;

const getJson = <T>(key: string, fallback: T): T => {
  const row = db.prepare("SELECT value_json FROM kv_state WHERE key = ?").get(key) as { value_json: string } | undefined;
  return row ? JSON.parse(row.value_json) as T : fallback;
};
const setJson = db.transaction((key: string, value: unknown) => {
  db.prepare(`INSERT INTO kv_state(key, value_json, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(key, JSON.stringify(value), Date.now());
});

/** Exact authenticated create inputs retained for recovery, never proof of success. */
export interface ListingPreparation {
  anchorAddress: string;
  transactionJson: string;
}

/** Read a retained attempt or undefined; throws on storage failure. */
export function loadListingPreparation(chainIdentity: string, logicalAddress: string): ListingPreparation | undefined {
  return db.prepare(`SELECT anchor_address AS anchorAddress, transaction_json AS transactionJson
    FROM listing_preparations WHERE chain_identity=? AND logical_address=?`)
    .get(chainIdentity, logicalAddress) as ListingPreparation | undefined;
}

/**
 * Commit authenticated inputs before releasing a transaction. Returns false if
 * another preparation already won; never overwrites it. Throws on storage failure.
 * Retain even after readback: a later missing read cannot free an immutable version.
 */
export function saveListingPreparation(chainIdentity: string, logicalAddress: string, preparation: ListingPreparation): boolean {
  return db.prepare(`INSERT INTO listing_preparations(chain_identity,logical_address,anchor_address,transaction_json)
    VALUES (?,?,?,?) ON CONFLICT(chain_identity,logical_address) DO NOTHING`)
    .run(chainIdentity, logicalAddress, preparation.anchorAddress, preparation.transactionJson).changes === 1;
}

// One-time, atomic migrations. Legacy files remain as rollback snapshots.
// Every read-then-write migration starts IMMEDIATE so concurrent fresh
// processes queue before observing state instead of racing a DEFERRED upgrade.
if (!(db.prepare("SELECT 1 FROM kv_state WHERE key='schema-version'").get())) db.transaction(() => {
  setJson("catalog", readLegacy<Catalog>(LEGACY.catalog, { catalogVersion: "1", generatedAt: 0, sellers: [] }));
  setJson("registrations", readLegacy<Registration[]>(LEGACY.registrations, []));
  setJson("scan-state", readLegacy<ScanState>(LEGACY.scanState, { lastSeenTxId: 0, listings: {}, deals: {} }));
  setJson("domains", readLegacy<string[]>(LEGACY.domains, []));
  setJson("fixtures", readLegacy<FixtureSeed[]>(LEGACY.fixtures, []));
  setJson("schema-version", 1);
}).immediate();

// Every persisted anchor time written before this migration came from the
// transaction's producer-controlled timestamp. Remove both the artifact rows
// and their already-materialised catalog derivatives atomically. Keeping the
// listings while recomputing seller reputation on the permitted finalisedAt
// fallback avoids serving stale SR-2 claims before the first v6 reindex; per-
// listing hints return only after that successful reindex.
if (getJson("sr2-anchor-schema-version", 0) < 2) db.transaction(() => {
  db.prepare("UPDATE artifacts SET anchor_time = NULL").run();
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  const windowEnd = catalog.generatedAt || Date.now();
  setJson("catalog", {
    ...catalog,
    sellers: catalog.sellers.map((seller) => {
      const deals = seller.deals.map(({ anchorTimestamp: _unsafeAnchorTimestamp, ...deal }) => deal);
      return {
        ...seller,
        deals,
        listings: seller.listings.map(({ reputationHint: _unsafeReputationHint, ...listing }) => listing),
        reputation: deriveSellerReputation(deals, 0, windowEnd),
      };
    }),
  });
  setJson("sr2-anchor-schema-version", 2);
}).immediate();

// Early Directory builds exposed the internal name `revocationBinding` in
// ListingSummary. DACS-1 uses `revocation`; migrate persisted catalogs once so
// every public surface and restart path now emits the normative wire field.
// A binding is promoted only when it is complete and names this very Listing;
// a revoked row without one stays out of discovery until a reindex rebuilds it.
const bindsListing = (binding: Partial<RevocationBinding> | undefined, listing: ListingSummary): binding is RevocationBinding =>
  typeof binding?.sellerPrimaryClaim === "string" && typeof listing.seller?.primaryClaim === "string" &&
  sellerIdentity(binding.sellerPrimaryClaim) === sellerIdentity(listing.seller.primaryClaim) &&
  bindsListingTuple(binding, binding.sellerPrimaryClaim, { listingId: listing.listingId, version: listing.version, contentHash: listing.contentHash });
if (getJson("listing-summary-revocation-schema-version", 0) < 1) db.transaction(() => {
  type LegacyListingSummary = ListingSummary & { revocationBinding?: RevocationBinding };
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  setJson("catalog", {
    ...catalog,
    sellers: catalog.sellers.map((seller) => ({
      ...seller,
      listings: seller.listings.map((listing) => {
        const { revocationBinding, revocation: stored, ...current } = listing as LegacyListingSummary;
        const revocation = [stored, revocationBinding].find((binding) => bindsListing(binding, listing));
        return {
          ...current,
          ...(current.status === "revoked" && revocation ? { revocation } : {}),
        };
      }),
    })),
  });
  setJson("listing-summary-revocation-schema-version", 1);
}).immediate();

// Catalog authentication is deliberately narrower than the current SDK's
// buyer-local LR-1..LR-3 decision. Persist that distinction on every existing
// summary so old catalogs cannot imply transaction readiness after upgrade.
if (getJson("listing-summary-readiness-schema-version", 0) < 1) db.transaction(() => {
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  setJson("catalog", {
    ...catalog,
    sellers: catalog.sellers.map((seller) => ({
      ...seller,
      listings: seller.listings.map((listing) => ({
        ...listing,
        transactionReadiness: DIRECTORY_TRANSACTION_READINESS,
      })),
    })),
  });
  setJson("listing-summary-readiness-schema-version", 1);
}).immediate();

// Cached admission decisions predate the current Listing reader (including
// DACS-4 §9.6.3 DPA-1). A readiness label cannot validate their original bytes.
// Withhold active summaries, and every cached deal verdict, until a successful
// reindex authenticates them with this reader. Keep
// registration/scan pointers and authenticated tombstones so outages cannot
// restore stale offers or erase withdrawal history. Fixture
// listings are not chain admission decisions and stay. The highest version of
// each chain Listing, tombstones included, is kept privately so the publisher
// still numbers a new version after it even when a later reindex drops the
// row. Bump this version whenever a reader change invalidates earlier
// admission decisions.
const LISTING_VERSION_FLOORS_KEY = "listing-version-floors";
const listingVersionFloorKey = (seller: string, listingId: string): string => `${seller}\n${listingId}`;
db.transaction(() => {
  if (getJson("listing-admission-schema-version", 0) >= 1) return;
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  const floors = getJson<Record<string, number>>(LISTING_VERSION_FLOORS_KEY, {});
  // Persisted rows predate any shape guarantee: a row without an anchor is
  // withheld like any other unauthenticated one, never a reason to stop startup.
  const retained = (listing: ListingSummary): boolean =>
    listing.status === "revoked" || listing.anchor?.kind === "fixture";
  for (const seller of catalog.sellers) for (const listing of seller.listings.filter((entry) => entry.anchor?.kind !== "fixture")) {
    if (typeof listing.listingId !== "string" || !Number.isSafeInteger(listing.version) || listing.version < 1) continue;
    const key = listingVersionFloorKey(seller.primaryClaim, listing.listingId);
    floors[key] = Math.max(floors[key] ?? 0, listing.version);
  }
  setJson(LISTING_VERSION_FLOORS_KEY, floors);
  // A deal's verdict was reached with a Listing reader that no longer applies,
  // and a deal does not record which Listing it was checked against (it may be
  // a revoked one, or one with no summary). Every cached verdict is withheld
  // and the reputation counted from them is recomputed.
  const windowEnd = catalog.generatedAt || Date.now();
  setJson("catalog", { ...catalog, sellers: catalog.sellers.map((seller) => {
    const deals = (seller.deals ?? []).map((deal) => ({ ...deal, refsVerified: false, reputationEligible: false }));
    return { ...seller, deals, listings: seller.listings.filter(retained), reputation: deriveSellerReputation(deals, 0, windowEnd) };
  }) });
  setJson("listing-admission-schema-version", 1);
}).immediate();

// Old catalog verdicts predate commitment authentication. Clear only derived deal
// credit atomically; retain Listing discovery, withdrawal evidence and scan pointers.
db.transaction(() => {
  if (getJson("commitment-finality-schema-version", 0) >= 1) return;
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  setJson("catalog", { ...catalog, sellers: catalog.sellers.map((seller) => {
    const deals = (seller.deals ?? []).map((deal) => ({ ...deal, refsVerified: false, reputationEligible: false }));
    return { ...seller, deals,
      listings: seller.listings.map(({ reputationHint: _unprovenHint, ...listing }) => listing),
      reputation: deriveSellerReputation(deals, 0, catalog.generatedAt) };
  }) });
  setJson("commitment-finality-schema-version", 1);
}).immediate();

/**
 * The highest version of a seller's Listing that a past admission reset
 * withheld from the catalog, or 0. The publisher numbers new versions after it.
 */
export const listingVersionFloor = (seller: string, listingId: string): number =>
  getJson<Record<string, number>>(LISTING_VERSION_FLOORS_KEY, {})[listingVersionFloorKey(seller, listingId)] ?? 0;

// Keep source-specific upgrade holds even when no candidate was queued. v2 did
// not retain source provenance, so only an authenticated recrawl can release it.
db.transaction(() => {
  const version = getJson<number>("withdrawal-carriage-schema-version", 0);
  if (version >= 4) return;
  const sources = getJson<WithdrawalSource[]>("withdrawal-sources", []);
  for (const source of sources) {
    source.incomplete = [...new Set([...source.hashes, ...source.incomplete])];
    source.provenance = version === 3 ? "publisher-signature" : "legacy";
    // Legacy bindings must not create candidate authority before revalidation.
    if (source.provenance === "legacy") delete source.bindings;
  }
  setJson("withdrawal-sources", sources);
  const ambiguousHashes = (db.prepare("SELECT DISTINCT listing_hash FROM revocation_candidates WHERE owner IS NULL AND content_hash IS NULL")
    .all() as Array<{ listing_hash: string }>).map((row) => row.listing_hash);
  if (ambiguousHashes.length) {
    db.prepare("DELETE FROM revocation_candidates WHERE owner IS NULL AND content_hash IS NULL").run();
    const state = getJson<ScanState>("scan-state", { lastSeenTxId: 0, listings: {}, deals: {} });
    setJson("scan-state", { ...state, schemaVersion: 0 });
    // The candidate's seller is unknown, but its listing hash is still known.
    // Unrelated offers need no quarantine while chain history is replayed.
    setJson("withdrawal-carriage-replay-hashes", ambiguousHashes);
  }
  if (ambiguousHashes.length || sources.length) {
    const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
    setJson("catalog", { ...catalog, sellers: catalog.sellers.map((seller) => ({ ...seller,
      listings: seller.listings.filter((listing) => listing.status === "revoked" || (!ambiguousHashes.includes(listing.contentHash) &&
        !sources.some((source) => source.seller === seller.primaryClaim &&
          (source.incomplete.includes(listing.contentHash) || source.incomplete.includes("*"))))),
    })) });
  }
  setJson("withdrawal-carriage-schema-version", 4);
}).immediate();

/**
 * Revocation candidates, per listing content hash. Each locator is admitted
 * once and stays pending until it is read and fails RB-4; a rejected locator
 * is admitted again only when the chain shows it with a different stored
 * value (`content_hash` hashes the whole value, signature envelope included).
 * `seq` is arrival order; an unreadable candidate is given a new one, so it
 * moves behind the others and is retried later.
 */
export interface RevocationCandidateObservation { locator: string; owner?: string | null; contentHash?: string | null }
const nextCandidateSeq = db.prepare("SELECT COALESCE(MAX(seq),0) + 1 seq FROM revocation_candidates");
const upsertCandidate = db.prepare(`INSERT INTO revocation_candidates(listing_hash,locator,owner,content_hash,seq,state)
  VALUES (@listingHash,@locator,@owner,@contentHash,@seq,'pending')
  ON CONFLICT(listing_hash,locator) DO UPDATE SET
    owner=COALESCE(excluded.owner,revocation_candidates.owner),
    content_hash=COALESCE(excluded.content_hash,revocation_candidates.content_hash),
    seq=CASE WHEN revocation_candidates.state='rejected' AND excluded.content_hash IS NOT NULL
      AND excluded.content_hash IS NOT revocation_candidates.content_hash THEN excluded.seq ELSE revocation_candidates.seq END,
    state=CASE WHEN revocation_candidates.state='rejected' AND excluded.content_hash IS NOT NULL
      AND excluded.content_hash IS NOT revocation_candidates.content_hash THEN 'pending' ELSE revocation_candidates.state END`);
export const admitRevocationCandidates = db.transaction(
  (listingHash: string, candidates: readonly RevocationCandidateObservation[]): void => {
    let seq = (nextCandidateSeq.get() as { seq: number }).seq;
    for (const candidate of candidates) {
      upsertCandidate.run({ listingHash, locator: candidate.locator, seq: seq++,
        owner: candidate.owner ? canonicalProgramOwner(candidate.owner) : null, contentHash: candidate.contentHash ?? null });
    }
  },
);
/** Call only with authenticated carriage bound to an independently verified listing. */
export const admitWellKnownRevocationCandidates = db.transaction((listingHash: string, locators: string[]): void => {
  admitRevocationCandidates(listingHash, locators.map((locator) => ({ locator })));
  // A fresh signed binding can describe changed bytes at an old locator. Read
  // again rather than trusting a rejection cached for its previous value.
  const recheck = db.prepare("UPDATE revocation_candidates SET state='pending' WHERE listing_hash=? AND locator=? AND state='rejected'");
  for (const locator of locators) recheck.run(listingHash, locator);
});
/** Candidate queues carried in scan-state JSON by earlier releases move into the table, in their stored order. */
const ingestLegacyRevocations = (revocations: ScanState["revocations"]): void => {
  const artifact = db.prepare("SELECT owner, content_hash FROM artifacts WHERE locator = ?");
  for (const [listingHash, stored] of Object.entries(revocations ?? {})) {
    const locators = Array.isArray(stored) ? stored : stored ? [stored] : [];
    admitRevocationCandidates(listingHash, locators.map((locator) => {
      const row = artifact.get(locator) as { owner: string | null; content_hash: string | null } | undefined;
      return { locator, owner: row?.owner, contentHash: row?.content_hash };
    }));
  }
};
db.transaction(() => {
  const state = getJson<ScanState | null>("scan-state", null);
  if (!state?.revocations || Object.keys(state.revocations).length === 0) return;
  ingestLegacyRevocations(normalizeScanState(state).revocations);
  setJson("scan-state", { ...state, revocations: {} });
}).immediate();

const pendingCandidates = db.prepare(`SELECT locator FROM revocation_candidates
  WHERE listing_hash = ? AND state = 'pending' AND NOT EXISTS (
    SELECT 1 FROM revocation_candidate_retries r WHERE r.listing_hash = revocation_candidates.listing_hash
      AND r.locator = revocation_candidates.locator AND r.retry_after > ?
  ) ORDER BY seq LIMIT ?`);
const pendingOwnerCandidates = db.prepare(`SELECT locator FROM revocation_candidates
  WHERE listing_hash = ? AND owner = ? AND state = 'pending' AND NOT EXISTS (
    SELECT 1 FROM revocation_candidate_retries r WHERE r.listing_hash = revocation_candidates.listing_hash
      AND r.locator = revocation_candidates.locator AND r.retry_after > ?
  ) ORDER BY seq LIMIT ?`);
/**
 * The next `limit` candidates to verify for a listing: those anchored by the
 * listing's owner first, then the rest in arrival order. Two indexed queries
 * of at most `limit` rows each, whatever the queue length.
 */
export function nextRevocationCandidates(listingHash: string, listingOwner: string | null, limit: number): string[] {
  const rows = (statement: Database.Statement, ...params: unknown[]) =>
    (statement.all(...params) as Array<{ locator: string }>).map((row) => row.locator);
  const now = Date.now();
  const owned = listingOwner ? rows(pendingOwnerCandidates, listingHash, canonicalProgramOwner(listingOwner), now, limit) : [];
  return [...new Set([...owned, ...rows(pendingCandidates, listingHash, now, limit)])].slice(0, limit);
}
const anyPendingCandidate = db.prepare(`SELECT 1 FROM revocation_candidates
  WHERE listing_hash = ? AND state = 'pending' LIMIT 1`);
/** True while any candidate for a listing is unread or not yet examined, so its RB-4 check is incomplete. */
export const hasPendingRevocationCandidates = (listingHash: string): boolean =>
  anyPendingCandidate.get(listingHash) !== undefined;

/** Discovery bytes are retained so a carrier's later ACL change cannot erase a signed marker. */
export function observedRevocationCandidate(locator: string): Record<string, unknown> | null {
  const row = db.prepare("SELECT data_json FROM artifacts WHERE locator=? AND kind='listing-revocation'")
    .get(locator) as { data_json: string | null } | undefined;
  return row?.data_json ? JSON.parse(row.data_json) : null;
}

export function retainedListingRevocation(hash: string): RevocationBinding | null {
  return getJson<{ binding: RevocationBinding } | null>(`listing-revocation:${hash}`, null)?.binding ?? null;
}
/** Return original marker bytes or null; storage errors propagate. Reverify bytes before using signed timing. */
export function retainedListingRevocationMarker(hash: string): Record<string, unknown> | null {
  return getJson<{ marker: Record<string, unknown> } | null>(`listing-revocation:${hash}`, null)?.marker ?? null;
}
/** Call only after RB-4 verification against the independently verified listing signer. */
export function retainListingRevocation(binding: RevocationBinding, marker: Record<string, unknown>): void {
  db.transaction(() => {
    const earlier = retainedListingRevocationMarker(binding.listingContentHash);
    if (typeof earlier?.revokedAt === "number" && typeof marker.revokedAt === "number" && earlier.revokedAt <= marker.revokedAt) return;
    setJson(`listing-revocation:${binding.listingContentHash}`, { binding, marker });
  }).immediate();
}
const ownerPendingCandidate = db.prepare(`SELECT 1 FROM revocation_candidates
  WHERE listing_hash = ? AND owner = ? AND state = 'pending' LIMIT 1`);
/**
 * Whether the Listing's own owner anchored a marker that no read has settled: unread,
 * backing off or still queued. Anyone may anchor other candidates, so only the owner's count.
 * Returns false when the owner is unknown.
 */
export function hasPendingOwnerRevocationCandidate(listingHash: string, listingOwner: string | null): boolean {
  if (!listingOwner) return false;
  return ownerPendingCandidate.get(listingHash, canonicalProgramOwner(listingOwner)) !== undefined;
}

// Earlier releases persisted unreadable candidates as rejected without a
// trustworthy reason: 403/404 replies before version 1, and replies whose data
// is not an object before version 2. Reverify those decisions once. Those releases
// also never held an offer for an unsettled candidate, so after the requeue (and
// the scan-state queue import above) withhold exactly the active catalog entries
// the live hold rule holds, before the first reindex can run. Stored owners are
// respelled the way that rule looks them up.
// Bump this version whenever a reader change turns a past rejection into an unread.
const REVOCATION_READ_SCHEMA_VERSION = 2;
db.transaction(() => {
  if (getJson("revocation-read-schema-version", 0) >= REVOCATION_READ_SCHEMA_VERSION) return;
  const respell = db.prepare("UPDATE revocation_candidates SET owner=? WHERE owner=?");
  for (const { owner } of db.prepare("SELECT DISTINCT owner FROM revocation_candidates WHERE owner IS NOT NULL").all() as Array<{ owner: string }>) {
    if (canonicalProgramOwner(owner) !== owner) respell.run(canonicalProgramOwner(owner), owner);
  }
  db.prepare(`DELETE FROM revocation_candidate_retries WHERE EXISTS (
    SELECT 1 FROM revocation_candidates c WHERE c.listing_hash=revocation_candidate_retries.listing_hash
      AND c.locator=revocation_candidate_retries.locator AND c.state='rejected'
  )`).run();
  db.prepare("UPDATE revocation_candidates SET state='pending' WHERE state='rejected'").run();
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  setJson("catalog", { ...catalog, sellers: catalog.sellers.map((seller) => {
    // An admitted Listing's storage owner is the seller's own key; a claim without one fails closed.
    const listingOwner = /[0-9a-fA-F]{64}$/.test(seller.primaryClaim) ? seller.primaryClaim : null;
    const held = (hash: string) => listingOwner ? hasPendingOwnerRevocationCandidate(hash, listingOwner) : hasPendingRevocationCandidates(hash);
    return { ...seller, listings: seller.listings.filter((listing) =>
      listing.status === "revoked" || listing.anchor?.kind === "fixture" || !held(listing.contentHash)) };
  }) });
  setJson("revocation-read-schema-version", REVOCATION_READ_SCHEMA_VERSION);
}).immediate();
const rejectCandidate = db.prepare("UPDATE revocation_candidates SET state='rejected' WHERE listing_hash = ? AND locator = ?");
const requeueCandidate = db.prepare(`UPDATE revocation_candidates SET seq = ?
  WHERE listing_hash = ? AND locator = ? AND state = 'pending'`);
const retryAttempts = db.prepare("SELECT attempts FROM revocation_candidate_retries WHERE listing_hash = ? AND locator = ?");
const scheduleRevocationRetry = db.prepare(`INSERT INTO revocation_candidate_retries(listing_hash,locator,attempts,retry_after)
  SELECT listing_hash,locator,?,? FROM revocation_candidates WHERE listing_hash=? AND locator=? AND state='pending'
  ON CONFLICT(listing_hash,locator) DO UPDATE SET attempts=excluded.attempts,retry_after=excluded.retry_after`);
const clearRevocationRetry = db.prepare("DELETE FROM revocation_candidate_retries WHERE listing_hash=? AND locator=?");
/** Unread candidates stay pending, move to the back, and retry with exponential 1–60 second backoff. */
export const recordRevocationProgress = db.transaction(
  (listingHash: string, progress: { unread: readonly string[]; rejected: readonly string[] },
    examinedBindings: readonly RevocationBinding[] = [], sourceRevision = -1): void => {
    for (const locator of progress.rejected) { rejectCandidate.run(listingHash, locator); clearRevocationRetry.run(listingHash, locator); }
    if (progress.rejected.length > 0 && examinedBindings.length > 0 && sourceRevision === wellKnownWithdrawalRevision()) {
      // Callers must reject these bindings only after a current marker read,
      // never from an older scanner observation. Compare exact binding
      // identities captured before the read. A slow
      // rejection must not erase a newer binding at the same marker address.
      // The source revision also protects a newer advertisement of identical
      // scope bytes whose previously invalid signature may have been repaired.
      const rejectedBindings = new Set(examinedBindings.filter((binding) =>
        binding.listingContentHash === listingHash && progress.rejected.includes(binding.markerAnchor.locator)).map(revocationBindingKey));
      const sources = withdrawalSources();
      for (const source of sources) source.bindings = (source.bindings ?? []).filter((binding) =>
        !rejectedBindings.has(revocationBindingKey(binding)));
      saveWithdrawalSources(sources);
    }
    let seq = (nextCandidateSeq.get() as { seq: number }).seq;
    for (const locator of progress.unread) {
      requeueCandidate.run(seq++, listingHash, locator);
      const attempts = (retryAttempts.get(listingHash, locator) as { attempts: number } | undefined)?.attempts ?? 0;
      scheduleRevocationRetry.run(Math.min(attempts + 1, 7), Date.now() + Math.min(60_000, 1_000 * 2 ** attempts), listingHash, locator);
    }
  },
);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cross-process/instance lease. SQLite serializes acquisition; expired leases recover automatically. */
export async function withDataLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const token = randomUUID();
  const deadline = Date.now() + 10_000;
  for (;;) {
    const acquired = db.transaction(() => {
      const now = Date.now();
      db.prepare("DELETE FROM leases WHERE name = ? AND expires_at <= ?").run(name, now);
      return db.prepare("INSERT OR IGNORE INTO leases(name, token, expires_at) VALUES (?, ?, ?)")
        .run(name, token, now + 2 * 60_000).changes === 1;
    })();
    if (acquired) break;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name} data lease`);
    await wait(25);
  }
  const renewal = setInterval(() => {
    db.prepare("UPDATE leases SET expires_at = ? WHERE name = ? AND token = ?").run(Date.now() + 2 * 60_000, name, token);
  }, 30_000);
  renewal.unref();
  try {
    return await fn();
  } finally {
    clearInterval(renewal);
    db.prepare("DELETE FROM leases WHERE name = ? AND token = ?").run(name, token);
  }
}

export const loadCatalog = (): Catalog => {
  const catalog: Catalog = getJson("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  for (const seller of catalog.sellers) for (const listing of seller.listings) {
    const legacy = listing as typeof listing & { revocationBinding?: typeof listing.revocation };
    if (listing.status === "revoked" && !listing.revocation && legacy.revocationBinding) listing.revocation = legacy.revocationBinding;
    delete legacy.revocationBinding;
  }
  return catalog;
};
export const saveCatalog = (catalog: Catalog): void => setJson("catalog", catalog);
export const loadRegistrations = (): Registration[] => getJson("registrations", []);
export const saveRegistrations = (regs: Registration[]): void => setJson("registrations", regs);
export const loadScanState = () => normalizeScanState(getJson("scan-state", { lastSeenTxId: 0, listings: {}, deals: {} }));
export const saveScanState = db.transaction((state: ScanState): void => {
  const normalized = normalizeScanState(state);
  ingestLegacyRevocations(normalized.revocations);
  setJson("scan-state", { ...normalized, revocations: {} });
});
/**
 * Remove active cache rows that belong to a replaced chain. Registrations and
 * the append-only first-observation history survive so operator diagnostics do
 * not rewrite an old failure's origin time as the rebuild time.
 */
export const clearChainDerivedArtifacts = db.transaction((): void => {
  db.prepare("DELETE FROM kv_state WHERE key LIKE 'listing-revocation:%'").run();
  db.prepare("DELETE FROM listing_rejections").run();
  db.prepare("DELETE FROM dead_letters").run();
  db.prepare("DELETE FROM artifacts").run();
  db.prepare("DELETE FROM revocation_candidates").run();
});

// A catalog writer persists some node reads while it indexes (rejections, revocation progress,
// retained markers). Until a later read confirms the node still serves the gated chain, each such
// write is journaled with the statement that undoes it, in the same transaction, so a failed check
// or a crash reverts it. Leases and run history are not journaled, nor are the keys in
// UNJOURNALED_KEYS.
db.exec("CREATE TABLE IF NOT EXISTS unconfirmed_chain_writes (seq INTEGER PRIMARY KEY AUTOINCREMENT, undo_sql TEXT NOT NULL)");
const UNJOURNALED_TABLES = new Set(["leases", "scan_runs", "unconfirmed_chain_writes", "sqlite_sequence"]);
/**
 * kv_state keys the journal skips. Other routes write registrations and domains while a pass runs, so
 * an undo would drop their saves. Withdrawal sources hold what a publisher signed and served from its
 * own domain, not what the node returned, so a refused chain check says nothing about them; undoing
 * them would let a failed pass publish a listing the publisher had already withdrawn.
 */
const UNJOURNALED_KEYS = ["registrations", "domains", "withdrawal-sources", "withdrawal-source-revision"];
const unjournaledKeyList = UNJOURNALED_KEYS.map((key) => `'${key}'`).join(",");
let journalTriggersCreated = false;
/** Per-connection triggers, created once every migration has run; they journal only while a window is open. */
function createJournalTriggers(): void {
  if (journalTriggersCreated) return;
  db.exec("CREATE TEMP TABLE IF NOT EXISTS unconfirmed_chain_window (opened INTEGER NOT NULL)");
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>)
    .map((row) => row.name).filter((name) => !UNJOURNALED_TABLES.has(name));
  for (const table of tables) {
    const columns = (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) => `"${column.name}"`);
    const oldValues = columns.map((column) => `quote(old.${column})`).join(" || ',' || ");
    const oldAssignments = columns.map((column) => `'${column}=' || quote(old.${column})`).join(" || ',' || ");
    const journal = (event: string, row: "old" | "new", undo: string) => db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS
      journal_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
      WHEN EXISTS (SELECT 1 FROM temp.unconfirmed_chain_window)${table === "kv_state" ? ` AND ${row}.key NOT IN (${unjournaledKeyList})` : ""}
      BEGIN INSERT INTO unconfirmed_chain_writes(undo_sql) VALUES (${undo}); END`);
    journal("INSERT", "new", `'DELETE FROM ${table} WHERE rowid=' || new.rowid`);
    journal("UPDATE", "old", `'UPDATE ${table} SET ' || ${oldAssignments} || ' WHERE rowid=' || old.rowid`);
    journal("DELETE", "old", `'INSERT INTO ${table}(rowid,${columns.join(",")}) VALUES(' || old.rowid || ',' || ${oldValues} || ')'`);
  }
  journalTriggersCreated = true;
}
/** Journal every chain-derived write from now until the window is confirmed or reverted. */
export function openChainReadWindow(): void {
  createJournalTriggers();
  db.prepare("INSERT INTO temp.unconfirmed_chain_window(opened) SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM temp.unconfirmed_chain_window)").run();
}
const closeChainReadWindow = (): void => {
  if (journalTriggersCreated) db.exec("DELETE FROM temp.unconfirmed_chain_window");
};
/**
 * Run the writer's last saves (its scan state and catalog) and keep the window's writes, in one
 * transaction: a chain read after those writes confirmed the gated chain, so either all of them are
 * durable or, after a failed save or a crash, none is. A failed save leaves the window open for
 * `revertChainReadWindow`.
 */
export const commitChainReadWindow = db.transaction((lastSaves: () => void): void => {
  lastSaves();
  closeChainReadWindow();
  db.exec("DELETE FROM unconfirmed_chain_writes");
});
/**
 * Undo every journaled write, newest first, and close the window. Also undoes the writes of a
 * window a crash left open, so every catalog writer calls it under its lease before it reads.
 */
export const revertChainReadWindow = db.transaction((): void => {
  closeChainReadWindow();
  const undo = db.prepare("SELECT undo_sql FROM unconfirmed_chain_writes ORDER BY seq DESC").all() as Array<{ undo_sql: string }>;
  for (const { undo_sql: statement } of undo) db.exec(statement);
  db.exec("DELETE FROM unconfirmed_chain_writes");
});
export const loadDomains = (): string[] => getJson("domains", []);
export const saveDomains = (domains: string[]): void => setJson("domains", [...new Set(domains)].sort());

interface WithdrawalSource { domain: string; seller: string; hashes: string[]; incomplete: string[];
  provenance?: WithdrawalProvenance | "legacy";
  bindings?: RevocationBinding[];
  index?: { generatedAt: number; hash: string };
  /** Content hashes by anchor from the last publisher-signed index accepted; absent on rows saved before them. */
  declarations?: Record<string, string> }
const withdrawalSources = (): WithdrawalSource[] => getJson("withdrawal-sources", []);
export const wellKnownWithdrawalRevision = (): number => getJson("withdrawal-source-revision", 0);
const saveWithdrawalSources = (sources: WithdrawalSource[]): void => {
  setJson("withdrawal-sources", sources);
  setJson("withdrawal-source-revision", wellKnownWithdrawalRevision() + 1);
};
/**
 * Authenticated recrawls reconcile metadata; only marker adjudication resolves a carried binding. An accepted
 * publisher-signed index saves its declared content hashes in the same transaction; an operator-pinned one keeps
 * the row's earlier declarations.
 */
export const recordWellKnownWithdrawalCheck = db.transaction((domain: string, seller?: string,
  hashes: string[] = [], incomplete: string[] = [], index?: WithdrawalSource["index"],
  bindings: NonNullable<WithdrawalSource["bindings"]> = [],
  provenance: WithdrawalProvenance = "publisher-signature", declarations?: Record<string, string>): boolean => {
  const sources = withdrawalSources();
  for (const source of sources) if (source.domain === domain) source.incomplete = [...new Set([...source.hashes, ...source.incomplete])];
  if (seller) {
    const prior = sources.find((source) => source.domain === domain && source.seller === seller);
    if (!index || (prior?.index && (index.generatedAt < prior.index.generatedAt ||
        (index.generatedAt === prior.index.generatedAt && index.hash !== prior.index.hash)))) {
      saveWithdrawalSources(sources);
      return false;
    }
    const missing = (prior?.hashes ?? []).filter((hash) => !hashes.includes(hash));
    // An active advertisement cannot retract an unread authenticated marker.
    // Keep its authority across replacement, retry and restart. Legacy sources
    // still require fresh authentication; a successful RB-4 rejection releases
    // the binding rather than turning arbitrary chain hints into authority.
    const retained = prior?.provenance !== "legacy" ? (prior?.bindings ?? []) : [];
    const carried = [...new Map([...retained, ...bindings].map((binding) => [revocationBindingKey(binding), binding])).values()];
    const next = { domain, seller, hashes: [...new Set([...hashes, ...missing])], incomplete: [...new Set([...incomplete, ...missing])], index, bindings: carried, provenance,
      declarations: provenance === "publisher-signature" ? declarations : prior?.declarations };
    if (prior) Object.assign(prior, next); else sources.push(next);
  }
  saveWithdrawalSources(sources);
  return true;
});
export const hasIncompleteWellKnownWithdrawal = (seller: string, hash: string): boolean =>
  getJson("withdrawal-carriage-replay-required", false) ||
  getJson<string[]>("withdrawal-carriage-replay-hashes", []).includes(hash) || withdrawalSources().some((source) =>
    source.seller === seller && (source.incomplete.includes(hash) || source.incomplete.includes("*") ||
      (source.provenance !== "legacy" && (source.bindings ?? []).some((binding) => binding.listingContentHash === hash))));
export const finishWithdrawalCarriageReplay = db.transaction((): void => {
  // Older v4 databases may still carry the global flag. Successful chain
  // replay clears it independently of each source's authenticated checks.
  setJson("withdrawal-carriage-replay-required", false);
  setJson("withdrawal-carriage-replay-hashes", []);
});

/** Called only after the indexer verifies the listing's signature and chain owner. */
export const boundWellKnownRevocations = (seller: string, hash: string, id: string, version: number) =>
  withdrawalSources().filter((source) => source.seller === seller && source.provenance !== "legacy").flatMap((source) =>
    (source.bindings ?? []).filter((binding) => binding.sellerPrimaryClaim === seller &&
      binding.listingContentHash === hash && binding.listingId === id && binding.listingVersion === version));

/** Continue bounded discovery work across passes, even across process restarts. */
export const loadWithdrawalCursor = (domain: string, seller: string, indexHash: string): number => {
  const saved = getJson<Record<string, { hash: string; cursor: number }>>("withdrawal-cursors", {})[`${domain}\n${seller}`];
  return saved?.hash === indexHash ? saved.cursor : 0;
};
export const saveWithdrawalCursor = (domain: string, seller: string, hash: string, cursor: number): void => {
  const cursors = getJson<Record<string, { hash: string; cursor: number }>>("withdrawal-cursors", {});
  cursors[`${domain}\n${seller}`] = { hash, cursor };
  setJson("withdrawal-cursors", cursors);
};


export const loadFixtureSeeds = (): FixtureSeed[] => {
  const seeds = getJson<unknown[]>("fixtures", []);
  return [...new Set(seeds.filter((seed): seed is FixtureSeed =>
    typeof seed === "string" && FIXTURE_SEEDS.has(seed as FixtureSeed),
  ))];
};
export const saveFixtureSeeds = (seeds: FixtureSeed[]): void =>
  setJson("fixtures", [...new Set(seeds)].filter((seed) => FIXTURE_SEEDS.has(seed)).sort());

export { canonicalProgramOwner };
export const programBindingKey = (owner: string, name: string): string => `${canonicalProgramOwner(owner)}\n${name}`;
export const findProgramAddress = (owner: string, name: string): string | null =>
  loadScanState().programs?.[programBindingKey(owner, name)] ?? null;
/**
 * Native address to read for an owner/name: the observed program, the legacy
 * derived address when none was observed, or null when duplicate programs
 * make the entry indeterminate. Null must never fall back to derivation.
 */
export function resolveProgramAddress(owner: string, name: string): string | null {
  const programs = loadScanState().programs;
  const key = programBindingKey(owner, name);
  return Object.hasOwn(programs, key) ? programs[key] : deriveAnchorAddress(owner, name);
}
export interface ArtifactObservation {
  locator: string; kind: string; profile: string; owner?: string; contentHash?: string;
  observedAt: number; anchorTime?: number; status?: string; data?: Record<string, unknown>;
  /** Set on the observation that accompanies a rejection; any other observation is a successful read. */
  rejected?: boolean;
}

type StoredArtifactObservation = Omit<ArtifactObservation, "owner" | "contentHash" | "anchorTime" | "status" | "rejected"> & {
  contentHash: string | null; owner: string | null; anchorTime: number | null; status: string; dataJson: string | null;
  rejected: number;
};

const recordArtifactTransaction = db.transaction((observation: StoredArtifactObservation) => {
  db.prepare(`INSERT INTO artifacts(locator, kind, profile, owner, content_hash, observed_at, anchor_time, status, data_json)
    VALUES (@locator,@kind,@profile,@owner,@contentHash,@observedAt,@anchorTime,@status,@dataJson)
    ON CONFLICT(locator) DO UPDATE SET kind=excluded.kind, profile=excluded.profile, owner=excluded.owner,
      content_hash=excluded.content_hash, observed_at=excluded.observed_at,
      anchor_time=CASE
        WHEN artifacts.content_hash IS NOT excluded.content_hash
          THEN excluded.anchor_time
        WHEN excluded.anchor_time IS NULL THEN artifacts.anchor_time
        WHEN artifacts.anchor_time IS NULL THEN excluded.anchor_time
        ELSE MIN(excluded.anchor_time,artifacts.anchor_time)
      END, status=excluded.status,
      data_json=excluded.data_json, error_code=NULL, error_message=NULL, retry_count=0,
      rejection_count=CASE WHEN @rejected THEN artifacts.rejection_count ELSE 0 END,
      deferred_at=CASE WHEN @rejected THEN artifacts.deferred_at ELSE NULL END, next_retry_at=NULL`)
    .run(observation);
  // A readable observation is the recovery event for this locator. Keep the
  // active queue truthful and ensure a later transient failure starts at one.
  db.prepare("DELETE FROM dead_letters WHERE locator = ?").run(observation.locator);
});

/**
 * The newest observation replaces the row's content identity as one unit: the
 * hash, the data it identifies and the hash-bound consensus time. Data is kept
 * only with its hash, and data that cannot be serialized is kept with neither.
 */
export function recordArtifact(observation: ArtifactObservation): void {
  let contentHash = observation.contentHash ?? null;
  let dataJson: string | null = null;
  if (contentHash && observation.data) {
    try {
      dataJson = boundedJson(observation.data);
      if (dataJson === null) contentHash = null;
    } catch {
      contentHash = null;
    }
  }
  const { rejected, ...observed } = observation;
  recordArtifactTransaction({ ...observed, contentHash,
    owner: observation.owner ?? null, anchorTime: contentHash ? observation.anchorTime ?? null : null,
    status: observation.status ?? "observed", dataJson, rejected: rejected ? 1 : 0 });
}

export interface ConsensusAnchorObservation {
  locator: string;
  contentHash: string;
  anchorTime: number;
}

/**
 * Return only reputation-relevant artifacts that still need SR-2 time. The v6
 * history replay re-reads artifacts and supplies their current canonical hash
 * before this query runs; rows without one cannot be safely attributed.
 */
export const loadUnanchoredBundleTargets = db.transaction((): Map<string, string> => {
  const rows = db.prepare(`SELECT locator,content_hash FROM artifacts
    WHERE kind='bundle' AND anchor_time IS NULL AND status='observed' AND content_hash IS NOT NULL
    ORDER BY locator`).all() as Array<{ locator: string; content_hash: string }>;
  return new Map(rows.map((row) => [row.locator, row.content_hash]));
});

/** Keep the earliest consensus observation, but only for the exact current content. */
export const recordConsensusAnchors = db.transaction((observations: ConsensusAnchorObservation[]): number => {
  const update = db.prepare(`UPDATE artifacts SET anchor_time = CASE
      WHEN anchor_time IS NULL THEN @anchorTime ELSE MIN(anchor_time,@anchorTime) END
    WHERE locator=@locator AND content_hash=@contentHash`);
  let changed = 0;
  for (const observation of observations) changed += update.run(observation).changes;
  return changed;
});

const countActiveRejected = db.prepare(`SELECT COUNT(*) count FROM artifacts WHERE ${REJECTED_ACTIVE} AND locator <> ?`);
const longestWaitingRejected = db.prepare(`SELECT locator FROM artifacts WHERE rejection_count > 0 AND deferred_at IS NOT NULL
  AND locator <> ? ORDER BY deferred_at, locator LIMIT 1`);
const activateRejected = db.prepare("UPDATE artifacts SET deferred_at=NULL, next_retry_at=? WHERE locator=?");

const recordArtifactFailureTransaction = db.transaction(
  (locator: string, kind: string, code: string, message: string, maxRetries: number) => {
    const prior = db.prepare("SELECT retry_count,rejection_count,deferred_at,kind FROM artifacts WHERE locator = ?").get(locator) as
      { retry_count: number; rejection_count: number; deferred_at: number | null; kind: string } | undefined;
    const rejected = code === "ARTIFACT_REJECTED";
    const rejections = (prior?.rejection_count ?? 0) + (rejected ? 1 : 0);
    // Content that was read ends a transient streak; transient failures have their own count.
    const attempts = rejected ? 0 : (prior?.retry_count ?? 0) + 1;
    const failureKind = kind === "unknown" && prior?.kind && prior.kind !== "unknown" ? prior.kind : kind;
    // Once its content was rejected, a locator stays periodic until a read succeeds.
    const periodic = rejections > 0;
    const dead = !periodic && attempts >= maxRetries;
    const now = Date.now();
    let next: number | null = dead ? null : now + Math.min(60 * 60_000, 2 ** Math.min(rejected ? rejections : attempts, 10) * 5_000);
    let deferredAt = periodic ? prior?.deferred_at ?? null : null;
    if (rejected) {
      const wasActive = (prior?.rejection_count ?? 0) > 0 && prior?.deferred_at == null;
      const waiting = longestWaitingRejected.get(locator) as { locator: string } | undefined;
      if (wasActive && waiting) {
        // Rotation: a retried locator yields its slot to the longest-waiting one.
        deferredAt = now;
        activateRejected.run(now, waiting.locator);
      } else if (!wasActive) {
        const full = (countActiveRejected.get(locator) as { count: number }).count >= MAX_ACTIVE_REJECTED_RETRIES;
        deferredAt = full ? deferredAt ?? now : null;
      }
    }
    if (deferredAt !== null) next = null;
    const storedCode = code.slice(0, 100);
    const storedMessage = message.slice(0, 1000);
    db.prepare(`INSERT INTO artifact_failure_history(locator,first_seen_at,last_seen_at,observations)
      VALUES (?,?,?,1) ON CONFLICT(locator) DO UPDATE SET
      last_seen_at=excluded.last_seen_at,observations=artifact_failure_history.observations+1`)
      .run(locator, now, now);
    // Hard row ceiling, enforced incrementally: fabricated unique locators can
    // arrive from arbitrary chain transactions, so at steady state each insert
    // evicts at most the few oldest-seen rows. Active dead-letters are safe —
    // dead_letters keeps its own first_seen_at copy (see COALESCE fallback in
    // indexerDiagnostics), so history eviction never rewrites the active queue.
    const { maxRows } = failureHistoryRetention();
    const excess = (db.prepare("SELECT COUNT(*) count FROM artifact_failure_history")
      .get() as { count: number }).count - maxRows;
    if (excess > 0) {
      db.prepare(`DELETE FROM artifact_failure_history WHERE locator IN (
        SELECT locator FROM artifact_failure_history
        ORDER BY last_seen_at ASC, locator ASC LIMIT ?)`).run(excess);
    }
    const history = db.prepare("SELECT first_seen_at FROM artifact_failure_history WHERE locator = ?")
      .get(locator) as { first_seen_at: number };
    db.prepare(`INSERT INTO artifacts(locator,kind,profile,observed_at,status,error_code,error_message,retry_count,next_retry_at,
      rejection_count,deferred_at) VALUES (?,?,?,? ,?,?,?,?,?,?,?) ON CONFLICT(locator) DO UPDATE SET status=excluded.status,
      error_code=excluded.error_code,error_message=excluded.error_message,retry_count=excluded.retry_count,
      next_retry_at=excluded.next_retry_at,rejection_count=excluded.rejection_count,deferred_at=excluded.deferred_at`)
      .run(locator, failureKind, "unknown", now, dead ? "dead-letter" : "retry", storedCode, storedMessage, attempts, next,
        rejections, deferredAt);
    if (dead) {
      db.prepare(`INSERT INTO dead_letters(locator,kind,error_code,error_message,attempts,first_seen_at,last_seen_at)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(locator) DO UPDATE SET kind=excluded.kind,error_code=excluded.error_code,
        error_message=excluded.error_message,attempts=excluded.attempts,last_seen_at=excluded.last_seen_at`)
        .run(locator, failureKind, storedCode, storedMessage, attempts, history.first_seen_at, now);
    } else {
      // Repair any legacy mismatch where a locator is retryable but still has
      // a stale row in the exhausted queue.
      db.prepare("DELETE FROM dead_letters WHERE locator = ?").run(locator);
    }
  },
);

export function recordArtifactFailure(locator: string, kind: string, code: string, message: string, maxRetries = 5): void {
  const retries = Number.isSafeInteger(maxRetries) && maxRetries >= 1 ? maxRetries : 5;
  recordArtifactFailureTransaction(locator, kind, code, message, retries);
}

/**
 * Retention policy for artifact_failure_history (issue #51). The table is
 * telemetry, not the active retry/dead-letter queue: pruning it only affects
 * the historical firstSeenAt/observations record. A locator pruned here and
 * failing again later starts a fresh history (firstSeenAt = rediscovery time);
 * an entry already promoted to dead_letters keeps its original first_seen_at
 * because that copy lives in dead_letters and is never updated on conflict.
 */
export function failureHistoryRetention(
  rawRows = process.env.DACS_FAILURE_HISTORY_MAX_ROWS,
  rawDays = process.env.DACS_FAILURE_HISTORY_MAX_AGE_DAYS,
): { maxRows: number; maxAgeMs: number } {
  const rows = rawRows === undefined ? 5_000 : Number(rawRows);
  const days = rawDays === undefined ? 30 : Number(rawDays);
  return {
    maxRows: Number.isSafeInteger(rows) && rows >= 100 && rows <= 100_000 ? rows : 5_000,
    maxAgeMs: (Number.isSafeInteger(days) && days >= 1 && days <= 365 ? days : 30) * 86_400_000,
  };
}

/**
 * Age-based prune, bounded per call so a pass after long downtime cannot
 * become a blocking maintenance operation. Called once per reindex pass;
 * returns rows removed (callers may loop while > 0 if they want to drain).
 */
export function pruneFailureHistory(now = Date.now(), batch = 500): number {
  const { maxAgeMs } = failureHistoryRetention();
  const limit = Number.isSafeInteger(batch) && batch >= 1 && batch <= 10_000 ? batch : 500;
  return db.prepare(`DELETE FROM artifact_failure_history WHERE locator IN (
    SELECT locator FROM artifact_failure_history WHERE last_seen_at < ?
    ORDER BY last_seen_at ASC, locator ASC LIMIT ?)`).run(now - maxAgeMs, limit).changes;
}

export const failureHistorySize = (): number =>
  (db.prepare("SELECT COUNT(*) count FROM artifact_failure_history").get() as { count: number }).count;

export function recordListingRejection(
  locator: string,
  registrationClaim: string,
  code: ListingRejectionCode,
  coordinates?: ListingDiagnosticCoordinates,
  publicNotice = false,
): void {
  const now = Date.now();
  db.prepare(`INSERT INTO listing_rejections(
      locator,registration_claim,reason_code,listing_id,listing_version,public_notice,occurrences,first_seen_at,last_seen_at
    ) VALUES (?,?,?,?,?,?,1,?,?)
    ON CONFLICT(locator,registration_claim) DO UPDATE SET
      reason_code=excluded.reason_code,
      listing_id=excluded.listing_id,
      listing_version=excluded.listing_version,
      public_notice=excluded.public_notice,
      occurrences=listing_rejections.occurrences+1,
      last_seen_at=excluded.last_seen_at`)
    .run(
      locator,
      registrationClaim.toLowerCase(),
      code,
      coordinates?.listingId ?? null,
      coordinates?.listingVersion ?? null,
      publicNotice && coordinates ? 1 : 0,
      now,
      now,
    );
}

/** The authenticated notice code for an anchor under a registration, or undefined when none is. */
export function listingRejectionNoticeCode(locator: string, registrationClaim: string): ListingRejectionCode | undefined {
  const row = db.prepare("SELECT reason_code FROM listing_rejections WHERE locator = ? AND registration_claim = ? AND public_notice = 1")
    .get(locator, registrationClaim.toLowerCase()) as { reason_code: ListingRejectionCode } | undefined;
  return row?.reason_code;
}

/** Whether this normalized domain previously supplied publisher-authenticated discovery. */
export const hasPublisherAuthenticatedWellKnownSource = (domain: string): boolean =>
  withdrawalSources().some((source) => source.domain === domain && source.provenance === "publisher-signature");

export function clearListingRejection(locator: string, registrationClaim: string): void {
  db.prepare("DELETE FROM listing_rejections WHERE locator = ? AND registration_claim = ?")
    .run(locator, registrationClaim.toLowerCase());
}

/** Clear all diagnostics when a seller leaves the registration set. */
export function clearRegistrationListingRejections(registrationClaim: string): void {
  db.prepare("DELETE FROM listing_rejections WHERE registration_claim = ?").run(registrationClaim.toLowerCase());
}

/** A seller's saved publisher-signed declarations from configured domains, and whether an older such source saved none. */
export interface SavedListingDeclarations { sources: Array<Record<string, string>>; unknown: boolean }

/** Read a seller's saved declarations, hashes as their index declared them. Storage failures throw. */
export function savedListingDeclarations(seller: string): SavedListingDeclarations {
  const configured = new Set(loadDomains().flatMap((domain) => {
    try { return [normalizeSubmittedDomain(domain)]; }
    catch { return []; /* An invalid legacy domain cannot identify a source. */ }
  }));
  const rows = withdrawalSources().filter((source) =>
    source.seller.toLowerCase() === seller.toLowerCase() && configured.has(source.domain));
  return {
    sources: rows.flatMap((source) => source.declarations ? [source.declarations] : []),
    unknown: rows.some((source) => !source.declarations && source.provenance === "publisher-signature"),
  };
}

const declaredBySavedSource = (saved: SavedListingDeclarations, locator: string): boolean =>
  saved.unknown || saved.sources.some((hashes) => Object.hasOwn(hashes, locator));

const listingRejectionRows = (claim: string) =>
  db.prepare("SELECT locator, reason_code, public_notice FROM listing_rejections WHERE registration_claim = ?")
    .all(claim) as Array<{ locator: string; reason_code: ListingRejectionCode; public_notice: number }>;

/**
 * Prune public notices of anchors the registration no longer lists once their evidence is gone: a hash notice when
 * no saved signed source declares the anchor, an owner notice when the verified owner-signed registration no longer
 * names it. Other rows wait for complete discovery (`pruneListingRejections`). Storage failures throw.
 */
export const pruneRegistrationListingRejections = db.transaction((
  registrationClaim: string,
  listedAnchors: readonly string[],
  ownerSignedAnchors?: readonly string[],
): void => {
  const claim = registrationClaim.toLowerCase();
  const saved = savedListingDeclarations(claim);
  for (const { locator, reason_code, public_notice } of listingRejectionRows(claim)) {
    if (public_notice !== 1 || listedAnchors.includes(locator)) continue;
    const evidenceGone = reason_code === "DECLARED_CONTENT_HASH_MISMATCH" ? !declaredBySavedSource(saved, locator)
      : reason_code === "OWNER_CLAIM_BINDING" && ownerSignedAnchors !== undefined && !ownerSignedAnchors.includes(locator);
    if (evidenceGone) clearListingRejection(locator, claim);
  }
});

/**
 * After complete discovery, prune diagnostics of pointers no indexed registration lists. A public hash notice stays
 * while a saved signed source declares its anchor; a listed seller's public owner notice is left to its owner
 * evidence (`pruneRegistrationListingRejections`). Storage failures throw.
 */
export const pruneListingRejections = db.transaction((
  registrations: ReadonlyArray<Pick<Registration, "primaryClaim" | "listingAnchors">>,
): void => {
  const listed = new Map<string, Set<string>>();
  for (const reg of registrations) {
    const claim = reg.primaryClaim.toLowerCase();
    listed.set(claim, new Set([...listed.get(claim) ?? [], ...reg.listingAnchors]));
  }
  for (const { registration_claim: claim } of db.prepare("SELECT DISTINCT registration_claim FROM listing_rejections").all() as Array<{ registration_claim: string }>) {
    const anchors = listed.get(claim);
    const saved = savedListingDeclarations(claim);
    for (const { locator, reason_code, public_notice } of listingRejectionRows(claim)) {
      if (anchors?.has(locator)) continue;
      const kept = public_notice === 1 && (reason_code === "DECLARED_CONTENT_HASH_MISMATCH"
        ? declaredBySavedSource(saved, locator) : reason_code === "OWNER_CLAIM_BINDING" && anchors !== undefined);
      if (!kept) clearListingRejection(locator, claim);
    }
  }
});
/**
 * Due retry locators for one pass, at most RETRY_READS_PER_PASS. Up to
 * REJECTED_RETRY_READS_PER_PASS of them are reserved for due rejected
 * locators; transient failures fill the rest and are returned first. Free
 * scheduled slots are first given to rejected locators waiting beyond the
 * ceiling, oldest first.
 */
export const loadRetryableArtifacts = db.transaction((now: number = Date.now()): string[] => {
  const active = (countActiveRejected.get("") as { count: number }).count;
  if (active < MAX_ACTIVE_REJECTED_RETRIES) {
    db.prepare(`UPDATE artifacts SET deferred_at=NULL, next_retry_at=? WHERE locator IN (SELECT locator FROM artifacts
      WHERE rejection_count > 0 AND deferred_at IS NOT NULL ORDER BY deferred_at, locator LIMIT ?)`)
      .run(now, MAX_ACTIVE_REJECTED_RETRIES - active);
  }
  const due = (where: string, limit: number) => (db.prepare(`SELECT locator FROM artifacts WHERE ${where}
    AND COALESCE(next_retry_at,0) <= ? ORDER BY COALESCE(next_retry_at,0),locator LIMIT ?`)
    .all(now, limit) as Array<{ locator: string }>).map((row) => row.locator);
  const rejected = due(REJECTED_ACTIVE, REJECTED_RETRY_READS_PER_PASS);
  return [...due("status='retry' AND rejection_count = 0", RETRY_READS_PER_PASS - rejected.length), ...rejected];
});
export const artifactAnchorTime = (locator: string): number | undefined =>
  (db.prepare("SELECT anchor_time FROM artifacts WHERE locator = ?").get(locator) as { anchor_time: number | null } | undefined)?.anchor_time ?? undefined;
/** Canonical storage owner recorded when the locator was last read, if any. */
export const artifactOwner = (locator: string): string | null => {
  const owner = (db.prepare("SELECT owner FROM artifacts WHERE locator = ?").get(locator) as { owner: string | null } | undefined)?.owner;
  return owner ? canonicalProgramOwner(owner) : null;
};

export function beginScanRun(fromTx: number): number {
  return Number(db.prepare("INSERT INTO scan_runs(started_at,from_tx,status) VALUES (?,?,?)").run(Date.now(), fromTx, "running").lastInsertRowid);
}
export function finishScanRun(id: number, values: { toTx: number; chainTip?: number; txs: number; artifacts: number; rejected: number; error?: string; omittedSellers?: number; omittedBindings?: number; omittedDeals?: number }): void {
  db.prepare(`UPDATE scan_runs SET finished_at=?,to_tx=?,chain_tip=?,txs_scanned=?,artifacts_observed=?,rejected=?,status=?,error=?,omitted_sellers=?,omitted_bindings=?,omitted_deals=? WHERE id=?`)
    .run(Date.now(), values.toTx, values.chainTip ?? null, values.txs, values.artifacts, values.rejected,
      values.error ? "failed" : "complete", values.error ?? null, values.omittedSellers ?? 0, values.omittedBindings ?? 0, values.omittedDeals ?? 0, id);
}
const PUBLIC_FAILURES: Record<string, string> = {
  STORAGE_UNREADABLE: "The storage program could not be read after repeated attempts. Confirm the locator exists and is publicly readable before retrying.",
  STORAGE_NOT_FOUND: "No storage program was found at this locator. The response is operational evidence only and is not authoritative DACS absence evidence.",
  STORAGE_NOT_PUBLIC: "A storage program exists at this locator but is not publicly readable. Publish it for unauthenticated reads before retrying.",
  STORAGE_RPC_UNAVAILABLE: "The storage program could not be read because the public node was unavailable after bounded retries.",
  STORAGE_INVALID_RESPONSE: "The public node returned a response that did not satisfy the storage-read contract after bounded retries.",
};
const DACS_ARTIFACT_KINDS = new Set(["listing", "listing-revocation", "bundle", "agreement", "evidence", "verify-result", "composite", "rating"]);

export interface PublicDeadLetterDiagnostic {
  locator: string;
  kind: string;
  classification: "dacs-artifact" | "unclassified-storage";
  code: string;
  message: string;
  attempts: number;
  firstSeenAt: number;
  lastSeenAt: number;
  retryState: "exhausted";
}

export interface PublicListingRejectionDiagnostic {
  locator: string;
  listingId?: string;
  listingVersion?: number;
  publicNotice: boolean;
  code: ListingRejectionCode;
  message: string;
  guidance: string;
  occurrences: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface IndexerDiagnosticsOptions {
  deadLetterLimit?: number;
  deadLetterLocator?: string;
}

export interface PublicScanRun {
  id: number;
  started_at: number;
  finished_at: number | null;
  from_tx: number;
  to_tx: number | null;
  chain_tip: number | null;
  txs_scanned: number;
  artifacts_observed: number;
  rejected: number;
  status: "running" | "complete" | "failed";
}

export interface IndexerDiagnostics {
  storage: "sqlite-wal";
  artifacts: Record<string, number>;
  deadLetters: number;
  deadLetterDiagnostics: {
    scope: "storage-read";
    total: number;
    byCode: Record<string, number>;
    byKind: Record<string, number>;
    query: { locator: string | null; limit: number };
    returned: number;
    hasMore: boolean;
    items: PublicDeadLetterDiagnostic[];
  };
  listingRejectionDiagnostics: {
    scope: "listing-admission";
    total: number;
    publicTotal: number;
    byCode: Record<string, number>;
    query: { locator: string | null; limit: number };
    returned: number;
    hasMore: boolean;
    items: PublicListingRejectionDiagnostic[];
  };
  lastRun: PublicScanRun | null;
}

interface DeadLetterRow {
  locator: string; kind: string; error_code: string; attempts: number;
  first_seen_at: number; last_seen_at: number;
}

interface ListingRejectionRow {
  locator: string;
  listing_id: string | null;
  listing_version: number | null;
  public_notice: number;
  reason_code: ListingRejectionCode;
  occurrences: number;
  first_seen_at: number;
  last_seen_at: number;
}

const publicFailure = (code: string): { code: string; message: string } =>
  PUBLIC_FAILURES[code]
    ? { code, message: PUBLIC_FAILURES[code] }
    : { code: "INDEXER_REJECTED", message: "The indexer could not process this storage reference. Contact the directory operator with the locator." };
const publicKind = (kind: string): string =>
  /^[a-z][a-z0-9-]{0,63}$/.test(kind) ? kind : "unknown";

const readIndexerDiagnostics = db.transaction((options: IndexerDiagnosticsOptions): IndexerDiagnostics => {
  const requestedLimit = options.deadLetterLimit ?? 20;
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(100, requestedLimit)) : 20;
  const locator = options.deadLetterLocator;
  const artifacts = db.prepare("SELECT status, COUNT(*) count FROM artifacts GROUP BY status").all() as Array<{ status: string; count: number }>;
  // The operator-only error column may contain raw RPC failures or internal
  // URLs. Keep the public status projection explicit so it cannot leak.
  const lastRun = db.prepare(`SELECT id,started_at,finished_at,from_tx,to_tx,chain_tip,
    txs_scanned,artifacts_observed,rejected,status FROM scan_runs ORDER BY id DESC LIMIT 1`).get() as PublicScanRun | undefined;
  const activeJoin = `FROM dead_letters dl
    INNER JOIN artifacts a ON a.locator=dl.locator AND a.status='dead-letter'
    LEFT JOIN artifact_failure_history fh ON fh.locator=dl.locator`;
  const deadLetters = (db.prepare(`SELECT COUNT(*) count ${activeJoin}`).get() as { count: number }).count;
  const counts = db.prepare(`SELECT dl.error_code, COUNT(*) count ${activeJoin} GROUP BY dl.error_code`).all() as Array<{ error_code: string; count: number }>;
  const byCode: Record<string, number> = {};
  for (const row of counts) {
    const code = publicFailure(row.error_code).code;
    byCode[code] = (byCode[code] ?? 0) + row.count;
  }
  const kindCounts = db.prepare(`SELECT dl.kind, COUNT(*) count ${activeJoin} GROUP BY dl.kind`).all() as Array<{ kind: string; count: number }>;
  const byKind: Record<string, number> = {};
  for (const row of kindCounts) {
    const kind = publicKind(row.kind);
    byKind[kind] = (byKind[kind] ?? 0) + row.count;
  }
  const where = locator ? " WHERE dl.locator = ?" : "";
  const statement = db.prepare(`SELECT dl.locator,dl.kind,dl.error_code,dl.attempts,
    COALESCE(fh.first_seen_at,dl.first_seen_at) first_seen_at,dl.last_seen_at
    ${activeJoin}${where} ORDER BY dl.last_seen_at DESC, dl.locator ASC LIMIT ?`);
  const rows = (locator ? statement.all(locator, limit + 1) : statement.all(limit + 1)) as DeadLetterRow[];
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row): PublicDeadLetterDiagnostic => {
    const failure = publicFailure(row.error_code);
    const kind = publicKind(row.kind);
    return {
      locator: row.locator,
      kind,
      classification: DACS_ARTIFACT_KINDS.has(kind) ? "dacs-artifact" : "unclassified-storage",
      ...failure,
      attempts: row.attempts,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      retryState: "exhausted",
    };
  });
  const listingRejectionTotal = (db.prepare("SELECT COUNT(*) count FROM listing_rejections")
    .get() as { count: number }).count;
  const listingRejectionCounts = db.prepare(
    "SELECT reason_code, COUNT(*) count FROM listing_rejections GROUP BY reason_code",
  ).all() as Array<{ reason_code: ListingRejectionCode; count: number }>;
  const listingWhere = locator ? " WHERE locator = ?" : "";
  const publicTotal = (db.prepare("SELECT COUNT(*) count FROM listing_rejections WHERE public_notice = 1").get() as { count: number }).count;
  const listingStatement = db.prepare(`SELECT locator,reason_code,listing_id,listing_version,public_notice,occurrences,first_seen_at,last_seen_at
    FROM listing_rejections${listingWhere}
    ORDER BY public_notice DESC, last_seen_at DESC, locator ASC LIMIT ?`);
  const listingRows = (locator
    ? listingStatement.all(locator, limit + 1)
    : listingStatement.all(limit + 1)) as ListingRejectionRow[];
  const listingHasMore = listingRows.length > limit;
  const listingItems = listingRows.slice(0, limit).map((row): PublicListingRejectionDiagnostic => ({
    locator: row.locator,
    publicNotice: row.public_notice === 1,
    ...(row.listing_id ? { listingId: row.listing_id } : {}),
    ...(row.listing_version !== null ? { listingVersion: row.listing_version } : {}),
    code: row.reason_code,
    message: LISTING_REJECTION_MESSAGES[row.reason_code],
    guidance: LISTING_REJECTION_GUIDANCE[row.reason_code],
    occurrences: row.occurrences,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  }));
  return {
    storage: "sqlite-wal",
    artifacts: Object.fromEntries(artifacts.map((row) => [row.status, row.count])),
    deadLetters,
    deadLetterDiagnostics: {
      scope: "storage-read", total: deadLetters, byCode, byKind,
      query: { locator: locator ?? null, limit }, returned: items.length, hasMore, items,
    },
    listingRejectionDiagnostics: {
      scope: "listing-admission",
      total: listingRejectionTotal,
      publicTotal,
      byCode: Object.fromEntries(listingRejectionCounts.map((row) => [row.reason_code, row.count])),
      query: { locator: locator ?? null, limit },
      returned: listingItems.length,
      hasMore: listingHasMore,
      items: listingItems,
    },
    lastRun: lastRun ?? null,
  };
});

export function indexerDiagnostics(options: IndexerDiagnosticsOptions = {}): IndexerDiagnostics {
  return readIndexerDiagnostics(options);
}
