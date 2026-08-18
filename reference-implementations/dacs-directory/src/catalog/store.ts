/** Transactional index repository backed by SQLite, with one-time JSON migration. */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Catalog, ListingSummary, Registration, RevocationBinding, ScanState } from "./types.js";
import { deriveSellerReputation } from "./reputation.js";
import {
  LISTING_REJECTION_MESSAGES,
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
    occurrences INTEGER NOT NULL DEFAULT 1,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    PRIMARY KEY(locator, registration_claim)
  );
  CREATE INDEX IF NOT EXISTS listing_rejections_recent_idx
    ON listing_rejections(last_seen_at DESC, locator);
`);

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

// One-time, atomic migration. Legacy files remain as rollback snapshots.
if (!(db.prepare("SELECT 1 FROM kv_state WHERE key='schema-version'").get())) db.transaction(() => {
  setJson("catalog", readLegacy<Catalog>(LEGACY.catalog, { catalogVersion: "1", generatedAt: 0, sellers: [] }));
  setJson("registrations", readLegacy<Registration[]>(LEGACY.registrations, []));
  setJson("scan-state", readLegacy<ScanState>(LEGACY.scanState, { lastSeenTxId: 0, listings: {}, deals: {} }));
  setJson("domains", readLegacy<string[]>(LEGACY.domains, []));
  setJson("fixtures", readLegacy<FixtureSeed[]>(LEGACY.fixtures, []));
  setJson("schema-version", 1);
})();

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
})();

// Early Directory builds exposed the internal name `revocationBinding` in
// ListingSummary. DACS-1 uses `revocation`; migrate persisted catalogs once so
// every public surface and restart path now emits the normative wire field.
if (getJson("listing-summary-revocation-schema-version", 0) < 1) db.transaction(() => {
  type LegacyListingSummary = ListingSummary & { revocationBinding?: RevocationBinding };
  const catalog = getJson<Catalog>("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
  setJson("catalog", {
    ...catalog,
    sellers: catalog.sellers.map((seller) => ({
      ...seller,
      listings: seller.listings.map((listing) => {
        const legacy = listing as LegacyListingSummary;
        const { revocationBinding, ...current } = legacy;
        const revocation = current.revocation ?? revocationBinding;
        return {
          ...current,
          ...(current.status === "revoked" && revocation ? { revocation } : {}),
        };
      }),
    })),
  });
  setJson("listing-summary-revocation-schema-version", 1);
})();

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

export const loadCatalog = (): Catalog => getJson("catalog", { catalogVersion: "1", generatedAt: 0, sellers: [] });
export const saveCatalog = (catalog: Catalog): void => setJson("catalog", catalog);
export const loadRegistrations = (): Registration[] => getJson("registrations", []);
export const saveRegistrations = (regs: Registration[]): void => setJson("registrations", regs);
export const loadScanState = (): ScanState => getJson("scan-state", { lastSeenTxId: 0, listings: {}, deals: {} });
export const saveScanState = (state: ScanState): void => setJson("scan-state", state);
/**
 * Remove active cache rows that belong to a replaced chain. Registrations and
 * the append-only first-observation history survive so operator diagnostics do
 * not rewrite an old failure's origin time as the rebuild time.
 */
export const clearChainDerivedArtifacts = db.transaction((): void => {
  db.prepare("DELETE FROM listing_rejections").run();
  db.prepare("DELETE FROM dead_letters").run();
  db.prepare("DELETE FROM artifacts").run();
});
export const loadDomains = (): string[] => getJson("domains", []);
export const saveDomains = (domains: string[]): void => setJson("domains", [...new Set(domains)].sort());
export const loadFixtureSeeds = (): FixtureSeed[] => {
  const seeds = getJson<unknown[]>("fixtures", []);
  return [...new Set(seeds.filter((seed): seed is FixtureSeed =>
    typeof seed === "string" && FIXTURE_SEEDS.has(seed as FixtureSeed),
  ))];
};
export const saveFixtureSeeds = (seeds: FixtureSeed[]): void =>
  setJson("fixtures", [...new Set(seeds)].filter((seed) => FIXTURE_SEEDS.has(seed)).sort());

/** Demos owners appear as both 0x addresses and did:demos:agent claims. */
export const canonicalProgramOwner = (owner: string): string => {
  const hex = owner.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `0x${hex.toLowerCase()}` : owner.toLowerCase();
};
export const programBindingKey = (owner: string, name: string): string => `${canonicalProgramOwner(owner)}\n${name}`;
export const findProgramAddress = (owner: string, name: string): string | null =>
  loadScanState().programs?.[programBindingKey(owner, name)] ?? null;

export interface ArtifactObservation {
  locator: string; kind: string; profile: string; owner?: string; contentHash?: string;
  observedAt: number; anchorTime?: number; status?: string; data?: Record<string, unknown>;
}

type StoredArtifactObservation = Omit<ArtifactObservation, "owner" | "contentHash" | "anchorTime" | "status"> & {
  contentHash: string | null; owner: string | null; anchorTime: number | null; status: string; dataJson: string | null;
};

const recordArtifactTransaction = db.transaction((observation: StoredArtifactObservation) => {
  db.prepare(`INSERT INTO artifacts(locator, kind, profile, owner, content_hash, observed_at, anchor_time, status, data_json)
    VALUES (@locator,@kind,@profile,@owner,@contentHash,@observedAt,@anchorTime,@status,@dataJson)
    ON CONFLICT(locator) DO UPDATE SET kind=excluded.kind, profile=excluded.profile, owner=excluded.owner,
      content_hash=COALESCE(excluded.content_hash,artifacts.content_hash), observed_at=excluded.observed_at,
      anchor_time=CASE
        WHEN excluded.content_hash IS NOT NULL AND artifacts.content_hash IS NOT excluded.content_hash
          THEN excluded.anchor_time
        WHEN excluded.anchor_time IS NULL THEN artifacts.anchor_time
        WHEN artifacts.anchor_time IS NULL THEN excluded.anchor_time
        ELSE MIN(excluded.anchor_time,artifacts.anchor_time)
      END, status=excluded.status,
      data_json=COALESCE(excluded.data_json,artifacts.data_json), error_code=NULL, error_message=NULL,
      retry_count=0, next_retry_at=NULL`)
    .run(observation);
  // A readable observation is the recovery event for this locator. Keep the
  // active queue truthful and ensure a later transient failure starts at one.
  db.prepare("DELETE FROM dead_letters WHERE locator = ?").run(observation.locator);
});

export function recordArtifact(observation: ArtifactObservation): void {
  recordArtifactTransaction({ ...observation, contentHash: observation.contentHash ?? null,
    owner: observation.owner ?? null, anchorTime: observation.anchorTime ?? null,
    status: observation.status ?? "observed", dataJson: observation.data ? JSON.stringify(observation.data) : null });
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

const recordArtifactFailureTransaction = db.transaction(
  (locator: string, kind: string, code: string, message: string, maxRetries: number) => {
    const prior = db.prepare("SELECT retry_count,kind FROM artifacts WHERE locator = ?").get(locator) as { retry_count: number; kind: string } | undefined;
    const attempts = (prior?.retry_count ?? 0) + 1;
    const failureKind = kind === "unknown" && prior?.kind && prior.kind !== "unknown" ? prior.kind : kind;
    const dead = attempts >= maxRetries;
    const now = Date.now();
    const next = dead ? null : now + Math.min(60 * 60_000, 2 ** attempts * 5_000);
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
    db.prepare(`INSERT INTO artifacts(locator,kind,profile,observed_at,status,error_code,error_message,retry_count,next_retry_at)
      VALUES (?,?,?,? ,?,?,?,?,?) ON CONFLICT(locator) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,
      error_message=excluded.error_message,retry_count=excluded.retry_count,next_retry_at=excluded.next_retry_at`)
      .run(locator, failureKind, "unknown", now, dead ? "dead-letter" : "retry", storedCode, storedMessage, attempts, next);
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
): void {
  const now = Date.now();
  db.prepare(`INSERT INTO listing_rejections(
      locator,registration_claim,reason_code,occurrences,first_seen_at,last_seen_at
    ) VALUES (?,?,?,1,?,?)
    ON CONFLICT(locator,registration_claim) DO UPDATE SET
      reason_code=excluded.reason_code,
      occurrences=listing_rejections.occurrences+1,
      last_seen_at=excluded.last_seen_at`)
    .run(locator, registrationClaim.toLowerCase(), code, now, now);
}

export function clearListingRejection(locator: string, registrationClaim: string): void {
  db.prepare("DELETE FROM listing_rejections WHERE locator = ? AND registration_claim = ?")
    .run(locator, registrationClaim.toLowerCase());
}
export const loadRetryableArtifacts = (now = Date.now()): string[] =>
  (db.prepare("SELECT locator FROM artifacts WHERE status='retry' AND next_retry_at <= ? ORDER BY next_retry_at LIMIT 100").all(now) as Array<{ locator: string }>).map((row) => row.locator);
export const artifactAnchorTime = (locator: string): number | undefined =>
  (db.prepare("SELECT anchor_time FROM artifacts WHERE locator = ?").get(locator) as { anchor_time: number | null } | undefined)?.anchor_time ?? undefined;

export function beginScanRun(fromTx: number): number {
  return Number(db.prepare("INSERT INTO scan_runs(started_at,from_tx,status) VALUES (?,?,?)").run(Date.now(), fromTx, "running").lastInsertRowid);
}
export function finishScanRun(id: number, values: { toTx: number; chainTip?: number; txs: number; artifacts: number; rejected: number; error?: string }): void {
  db.prepare(`UPDATE scan_runs SET finished_at=?,to_tx=?,chain_tip=?,txs_scanned=?,artifacts_observed=?,rejected=?,status=?,error=? WHERE id=?`)
    .run(Date.now(), values.toTx, values.chainTip ?? null, values.txs, values.artifacts, values.rejected,
      values.error ? "failed" : "complete", values.error ?? null, id);
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
  code: ListingRejectionCode;
  message: string;
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
  const listingStatement = db.prepare(`SELECT locator,reason_code,occurrences,first_seen_at,last_seen_at
    FROM listing_rejections${listingWhere}
    ORDER BY last_seen_at DESC, locator ASC LIMIT ?`);
  const listingRows = (locator
    ? listingStatement.all(locator, limit + 1)
    : listingStatement.all(limit + 1)) as ListingRejectionRow[];
  const listingHasMore = listingRows.length > limit;
  const listingItems = listingRows.slice(0, limit).map((row): PublicListingRejectionDiagnostic => ({
    locator: row.locator,
    code: row.reason_code,
    message: LISTING_REJECTION_MESSAGES[row.reason_code],
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
