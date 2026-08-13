/**
 * Chain reads for the Next app.
 *
 * Address derivation reproduces Demos StorageProgram's documented
 * sha256(deployer:name:nonce:salt) mapping using the already-vendored DACS
 * canonical primitive. New writes use the live empty-salt convention; the
 * legacy helper remains available only for old nonce-0/`dacs:v1` fallbacks.
 * Storage-program READS stay a plain
 * unauthenticated HTTP GET (`/storage-program/{address}`): that is the read
 * path the StorageProgram API prescribes. The app stays free of the Demos
 * client's unrelated multichain dependency tree.
 */
import { sha256Hex } from "@kynesyslabs/dacs/canonical";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
export const LIVE_STORAGE_SALT = "";
export const LEGACY_STORAGE_SALT = "dacs:v1";

function normalizedOwner(value: string): string | null {
  const hex = value.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `0x${hex.toLowerCase()}` : null;
}

/** Derive a native address from the exact producer-held write inputs. */
export function deriveStorageAddress(owner: string, name: string, nonce: number, salt: string): string {
  const deployer = normalizedOwner(owner) ?? owner;
  return `stor-${sha256Hex(`${deployer}:${name}:${nonce}:${salt}`).slice(0, 40)}`;
}

// Callers should supply the observed transaction nonce. The default exists
// only for reading anchors produced by the legacy nonce-0 DACS SDK.
export function deriveAnchorAddress(owner: string, name: string, nonce = 0): string {
  return deriveStorageAddress(owner, name, nonce, LEGACY_STORAGE_SALT);
}

/** Read an anchored artifact (null if absent / non-public). */
export interface AnchorRecord {
  data: Record<string, unknown>;
  owner?: string;
  programName?: string;
}

export async function readAnchorRecord(address: string): Promise<AnchorRecord | null> {
  if (!/^stor-[0-9a-f]{40}$/.test(address)) return null;
  try {
    const res = await fetch(`${RPC}/storage-program/${address}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      success?: boolean;
      data?: Record<string, unknown>;
      owner?: string;
      programName?: string;
    };
    return json?.success && json.data != null && typeof json.data === "object" && !Array.isArray(json.data)
      ? { data: json.data, owner: json.owner, programName: json.programName }
      : null;
  } catch {
    return null;
  }
}

export async function readAnchor(address: string): Promise<Record<string, unknown> | null> {
  return (await readAnchorRecord(address))?.data ?? null;
}

export type OwnedAnchorResolution =
  | { status: "present"; address: string; record: AnchorRecord }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

type ProgramCandidate = { storageAddress?: unknown; programName?: unknown };

/**
 * Producer-side resume lookup for one exact StorageProgram name.
 *
 * A native address includes the create-time nonce and cannot be recomputed on
 * retry. Search results are therefore owner-confirmed with fresh reads. Any
 * failed read, invalid candidate, or duplicate owned program is indeterminate:
 * callers MUST NOT turn that uncertainty into another create transaction.
 */
export async function resolveOwnedAnchorByName(
  programName: string,
  expectedOwner: string,
): Promise<OwnedAnchorResolution> {
  if (!programName || programName.length > 512) {
    return { status: "indeterminate", reason: "program name is invalid" };
  }
  const owner = normalizedOwner(expectedOwner);
  if (!owner) return { status: "indeterminate", reason: "expected owner is invalid" };

  let response: Response;
  try {
    response = await fetch(RPC + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        method: "nodeCall",
        params: [{
          type: "nodeCall",
          message: "searchStoragePrograms",
          sender: null,
          receiver: null,
          timestamp: null,
          data: {
            query: programName,
            options: { exactMatch: true, limit: 32, offset: 0 },
          },
          extra: "",
        }],
      }),
    });
  } catch {
    return { status: "indeterminate", reason: "program-name lookup failed" };
  }
  if (!response.ok) return { status: "indeterminate", reason: "program-name lookup failed" };

  let candidates: ProgramCandidate[];
  try {
    const body = await response.json() as { result?: unknown; response?: unknown };
    if (body.result !== 200 || !Array.isArray(body.response)) {
      return { status: "indeterminate", reason: "program-name lookup returned an invalid response" };
    }
    candidates = body.response as ProgramCandidate[];
  } catch {
    return { status: "indeterminate", reason: "program-name lookup returned invalid JSON" };
  }
  if (candidates.length >= 32) {
    return { status: "indeterminate", reason: "program-name lookup reached its candidate bound" };
  }

  const exact = candidates.filter((candidate) => candidate.programName === programName);
  const records: Array<{ address: string; record: AnchorRecord }> = [];
  for (const candidate of exact) {
    if (typeof candidate.storageAddress !== "string" || !/^stor-[0-9a-f]{40}$/.test(candidate.storageAddress)) {
      return { status: "indeterminate", reason: "program-name lookup returned an invalid candidate" };
    }
    let read: Response;
    try {
      read = await fetch(`${RPC}/storage-program/${candidate.storageAddress}`, {
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      return { status: "indeterminate", reason: "a candidate could not be read to confirm ownership" };
    }
    if (!read.ok) {
      return { status: "indeterminate", reason: "a candidate could not be read to confirm ownership" };
    }
    let record: AnchorRecord | null = null;
    try {
      const body = await read.json() as {
        success?: boolean;
        data?: Record<string, unknown>;
        owner?: string;
        programName?: string;
      };
      if (
        body.success && body.data != null && typeof body.data === "object" && !Array.isArray(body.data) &&
        body.programName === programName
      ) {
        record = { data: body.data, owner: body.owner, programName: body.programName };
      }
    } catch { /* classified below */ }
    if (!record) {
      return { status: "indeterminate", reason: "a candidate returned invalid storage metadata" };
    }
    if (normalizedOwner(record.owner ?? "") === owner) {
      records.push({ address: candidate.storageAddress, record });
    }
  }

  if (records.length > 1) {
    return { status: "indeterminate", reason: "multiple owner-bound programs use the same name" };
  }
  return records[0]
    ? { status: "present", address: records[0].address, record: records[0].record }
    : { status: "absent" };
}
