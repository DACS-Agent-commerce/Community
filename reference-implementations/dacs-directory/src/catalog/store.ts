/**
 * Flat-file catalog store. The catalog is a CACHE (§6.3.6: "catalog-cached,
 * last-seen") — chain state is the source of truth, and every number the UI
 * shows is re-derivable client-side. A JSON file is honest about that; swap
 * for a DB when scale demands.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { Catalog, Registration, ScanState } from "./types.js";

const DATA_DIR = process.env.DACS_DIRECTORY_DATA ?? join(process.cwd(), "data");
const CATALOG_PATH = join(DATA_DIR, "catalog.json");
const REGISTRATIONS_PATH = join(DATA_DIR, "registrations.json");
const SCAN_STATE_PATH = join(DATA_DIR, "scan-state.json");

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Cross-process advisory lock for the local flat-file deployment. */
export async function withDataLock<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  mkdirSync(DATA_DIR, { recursive: true });
  const lock = join(DATA_DIR, `.${name}.lock`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch { /* another process released it */ }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${name} data lock`);
      await wait(25);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function atomicJsonWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}

export function loadCatalog(): Catalog {
  if (!existsSync(CATALOG_PATH)) {
    return { catalogVersion: "1", generatedAt: 0, sellers: [] };
  }
  return JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
}

export function saveCatalog(catalog: Catalog): void {
  atomicJsonWrite(CATALOG_PATH, catalog);
}

export function loadRegistrations(): Registration[] {
  if (!existsSync(REGISTRATIONS_PATH)) return [];
  return JSON.parse(readFileSync(REGISTRATIONS_PATH, "utf8")) as Registration[];
}

export function saveRegistrations(regs: Registration[]): void {
  atomicJsonWrite(REGISTRATIONS_PATH, regs);
}

/** Scan cursor + everything the scanner has EVER discovered (append-only —
 *  the sliding tx window must never make the catalog forget history; the
 *  chain remains the proof, this is just the memory of where to look). */
export function loadScanState(): ScanState {
  if (!existsSync(SCAN_STATE_PATH)) return { lastSeenTxId: 0, listings: {}, deals: {} };
  return JSON.parse(readFileSync(SCAN_STATE_PATH, "utf8")) as ScanState;
}

export const programBindingKey = (owner: string, name: string): string =>
  `${owner.toLowerCase()}\n${name}`;

export function findProgramAddress(owner: string, name: string): string | null {
  return loadScanState().programs?.[programBindingKey(owner, name)] ?? null;
}

export function saveScanState(state: ScanState): void {
  atomicJsonWrite(SCAN_STATE_PATH, state);
}

const DOMAINS_PATH = join(DATA_DIR, "domains.json");
/** Domains to crawl for §6.3.5 well-known surfaces. */
export function loadDomains(): string[] {
  if (!existsSync(DOMAINS_PATH)) return [];
  return JSON.parse(readFileSync(DOMAINS_PATH, "utf8")) as string[];
}
export function saveDomains(domains: string[]): void {
  atomicJsonWrite(DOMAINS_PATH, [...new Set(domains)].sort());
}
