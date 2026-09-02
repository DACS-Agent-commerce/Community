/**
 * Near-real-time catalog tailer.
 *
 * Notifications are an optimisation; the durable transaction cursor remains
 * the source of correctness. This worker polls the confirmed chain tip, wakes
 * the existing incremental scanner only when inputs advance, and periodically
 * re-verifies indeterminate/domain-backed data.
 */
import { mkdirSync, rmSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { latestConfirmedTransactionId } from "./chain.js";
import { reindexAll } from "./reindexCore.js";
import {
  catalogInputsModifiedAt,
  directoryDataPath,
  loadCatalog,
  loadScanState,
  saveIndexerRuntimeState,
  withDataLock,
} from "./store.js";
import type { IndexerRuntimeState } from "./types.js";

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_RETRY_MS = 30_000;
const DEFAULT_REFRESH_MS = 5 * 60_000;
const HEARTBEAT_MS = 15_000;
const LEASE_STALE_MS = 60_000;

export interface IndexDecisionInput {
  now: number;
  chainLatestTx: number | null;
  cursor: number;
  catalogGeneratedAt: number;
  inputsModifiedAt: number;
  lastCompletedAt?: number;
  hasIndeterminateAnchors: boolean;
  retryIntervalMs: number;
  fullRefreshIntervalMs: number;
}

export type IndexReason = "initial" | "chain" | "inputs" | "retry" | "maintenance" | null;

export function indexReason(input: IndexDecisionInput): IndexReason {
  if (input.catalogGeneratedAt === 0) return "initial";
  if (input.inputsModifiedAt > input.catalogGeneratedAt) return "inputs";
  if (input.chainLatestTx !== null && input.chainLatestTx > input.cursor) return "chain";
  const sinceLast = input.now - (input.lastCompletedAt ?? input.catalogGeneratedAt);
  if (input.hasIndeterminateAnchors && sinceLast >= input.retryIntervalMs) return "retry";
  if (sinceLast >= input.fullRefreshIntervalMs) return "maintenance";
  return null;
}

function boundedInterval(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function acquireLease(): { heartbeat: () => void; release: () => void } {
  const lock = join(directoryDataPath(), ".live-indexer.lock");
  mkdirSync(directoryDataPath(), { recursive: true });
  try {
    mkdirSync(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let stale = false;
    try {
      stale = Date.now() - statSync(lock).mtimeMs > LEASE_STALE_MS;
    } catch {
      stale = true;
    }
    if (!stale) throw new Error("another live indexer is already running");
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
  }
  return {
    heartbeat: () => {
      const now = new Date();
      utimesSync(lock, now, now);
    },
    release: () => rmSync(lock, { recursive: true, force: true }),
  };
}

export interface LiveIndexerOptions {
  signal: AbortSignal;
  log?: (line: string) => void;
}

export async function runLiveIndexer(options: LiveIndexerOptions): Promise<void> {
  const log = options.log ?? console.log;
  const pollIntervalMs = boundedInterval(process.env.DACS_INDEX_POLL_MS, DEFAULT_POLL_MS, 500);
  const retryIntervalMs = boundedInterval(process.env.DACS_INDEX_RETRY_MS, DEFAULT_RETRY_MS, 5_000);
  const fullRefreshIntervalMs = boundedInterval(
    process.env.DACS_INDEX_FULL_REFRESH_MS,
    DEFAULT_REFRESH_MS,
    30_000,
  );
  const lease = acquireLease();
  const startedAt = Date.now();
  let lastHeartbeatWrite = 0;
  let runtime: IndexerRuntimeState = {
    running: true,
    pid: process.pid,
    pollIntervalMs,
    startedAt,
    heartbeatAt: startedAt,
    indexing: false,
  };

  const persist = (patch: Partial<IndexerRuntimeState> = {}, force = false) => {
    runtime = { ...runtime, ...patch, heartbeatAt: Date.now() };
    if (!force && runtime.heartbeatAt - lastHeartbeatWrite < HEARTBEAT_MS) return;
    lease.heartbeat();
    saveIndexerRuntimeState(runtime);
    lastHeartbeatWrite = runtime.heartbeatAt;
  };

  persist({}, true);
  log(`live indexer listening every ${pollIntervalMs}ms`);

  try {
    while (!options.signal.aborted) {
      persist();
      const now = Date.now();
      const catalog = loadCatalog();
      const scan = loadScanState();
      const chainLatestTx = await latestConfirmedTransactionId();
      persist({ lastObservedChainTx: chainLatestTx });
      const reason = indexReason({
        now,
        chainLatestTx,
        cursor: scan.lastSeenTxId,
        catalogGeneratedAt: catalog.generatedAt,
        inputsModifiedAt: catalogInputsModifiedAt(),
        lastCompletedAt: runtime.lastCompletedAt,
        hasIndeterminateAnchors: Object.values(scan.anchors ?? {}).some(
          (anchor) => anchor.readStatus === "indeterminate",
        ),
        retryIntervalMs,
        fullRefreshIntervalMs,
      });

      if (reason) {
        const lastStartedAt = Date.now();
        persist({ indexing: true, lastStartedAt, lastError: undefined }, true);
        log(`indexing (${reason})${chainLatestTx === null ? "" : ` — chain tip ${chainLatestTx}`}`);
        try {
          const result = await withDataLock("reindex", () => reindexAll({ log }));
          persist({
            indexing: false,
            lastCompletedAt: Date.now(),
            lastResult: result,
            lastError: undefined,
          }, true);
          log(`live catalog updated — ${result.newTxs} new tx(s), ${result.sellers} seller(s)`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "indexing failed";
          persist({ indexing: false, lastError: message }, true);
          log(`live indexer: ${message}`);
        }
      }

      await wait(pollIntervalMs, options.signal);
    }
  } finally {
    try {
      persist({ running: false, indexing: false }, true);
    } finally {
      lease.release();
    }
  }
}
