/** Transactional index repository backed by SQLite, with one-time JSON migration. */
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type { Catalog, Registration, ScanState } from "./types.js";

export const DATA_DIR = process.env.DACS_DIRECTORY_DATA ?? join(process.cwd(), "data");
const DB_PATH = join(DATA_DIR, "directory.sqlite");
const LEGACY = {
  catalog: join(DATA_DIR, "catalog.json"),
  registrations: join(DATA_DIR, "registrations.json"),
  scanState: join(DATA_DIR, "scan-state.json"),
  domains: join(DATA_DIR, "domains.json"),
};

mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("busy_timeout = 10000");
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
  setJson("schema-version", 1);
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
export const loadDomains = (): string[] => getJson("domains", []);
export const saveDomains = (domains: string[]): void => setJson("domains", [...new Set(domains)].sort());

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
export function recordArtifact(observation: ArtifactObservation): void {
  db.prepare(`INSERT INTO artifacts(locator, kind, profile, owner, content_hash, observed_at, anchor_time, status, data_json)
    VALUES (@locator,@kind,@profile,@owner,@contentHash,@observedAt,@anchorTime,@status,@dataJson)
    ON CONFLICT(locator) DO UPDATE SET kind=excluded.kind, profile=excluded.profile, owner=excluded.owner,
      content_hash=COALESCE(excluded.content_hash,artifacts.content_hash), observed_at=excluded.observed_at,
      anchor_time=COALESCE(excluded.anchor_time,artifacts.anchor_time), status=excluded.status,
      data_json=COALESCE(excluded.data_json,artifacts.data_json), error_code=NULL, error_message=NULL`)
    .run({ ...observation, contentHash: observation.contentHash ?? null, owner: observation.owner ?? null,
      anchorTime: observation.anchorTime ?? null, status: observation.status ?? "observed",
      dataJson: observation.data ? JSON.stringify(observation.data) : null });
}
export function recordArtifactFailure(locator: string, kind: string, code: string, message: string, maxRetries = 5): void {
  const prior = db.prepare("SELECT retry_count FROM artifacts WHERE locator = ?").get(locator) as { retry_count: number } | undefined;
  const attempts = (prior?.retry_count ?? 0) + 1;
  const dead = attempts >= maxRetries;
  const next = dead ? null : Date.now() + Math.min(60 * 60_000, 2 ** attempts * 5_000);
  db.prepare(`INSERT INTO artifacts(locator,kind,profile,observed_at,status,error_code,error_message,retry_count,next_retry_at)
    VALUES (?,?,?,? ,?,?,?,?,?) ON CONFLICT(locator) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,
    error_message=excluded.error_message,retry_count=excluded.retry_count,next_retry_at=excluded.next_retry_at`)
    .run(locator, kind, "unknown", Date.now(), dead ? "dead-letter" : "retry", code, message.slice(0, 1000), attempts, next);
  if (dead) db.prepare(`INSERT INTO dead_letters(locator,kind,error_code,error_message,attempts,first_seen_at,last_seen_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(locator) DO UPDATE SET error_code=excluded.error_code,error_message=excluded.error_message,
    attempts=excluded.attempts,last_seen_at=excluded.last_seen_at`)
    .run(locator, kind, code, message.slice(0, 1000), attempts, Date.now(), Date.now());
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
export function indexerDiagnostics(): Record<string, unknown> {
  const artifacts = db.prepare("SELECT status, COUNT(*) count FROM artifacts GROUP BY status").all() as Array<{ status: string; count: number }>;
  const lastRun = db.prepare("SELECT * FROM scan_runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown> | undefined;
  const deadLetters = (db.prepare("SELECT COUNT(*) count FROM dead_letters").get() as { count: number }).count;
  return { storage: "sqlite-wal", artifacts: Object.fromEntries(artifacts.map((row) => [row.status, row.count])), deadLetters, lastRun: lastRun ?? null };
}
