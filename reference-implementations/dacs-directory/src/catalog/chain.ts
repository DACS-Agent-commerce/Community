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
import { boundedJson, storageResponseJson, StorageResponseTooLarge } from "./artifactLimits.js";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import { gcrAuthHeaders } from "./gcr.js";

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
  /** Node-enforced access metadata; payload fields cannot substitute for this. */
  acl?: unknown;
}

/**
 * One storage read, classified. `absent` is a definitive answer that no
 * readable artifact object is at the locator (missing, non-public, or content
 * that cannot be one); `unavailable` is a transport or node failure, which
 * callers must treat as indeterminate rather than absent (DACS-1 RB-6).
 */
export type AnchorRead =
  | { status: "present"; record: AnchorRecord }
  | { status: "absent" }
  | { status: "unavailable" };

export async function readAnchorResult(address: string): Promise<AnchorRead> {
  if (!/^stor-[0-9a-f]{40}$/.test(address)) return { status: "absent" };
  let res: Response;
  try {
    res = await fetch(`${RPC}/storage-program/${address}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { status: "unavailable" };
  }
  // Only the node's own answer is definitive: `{ success: false, errorCode }` with NOT_FOUND on a 404
  // or PERMISSION_DENIED on a 403 (kynesyslabs/node storageprogram routes). Any other 4xx, such as a
  // proxy's or a wrong route's, leaves the read incomplete (RB-6).
  if (res.status === 404 || res.status === 403) {
    try {
      const answer = await storageResponseJson(res) as { success?: unknown; errorCode?: unknown } | null;
      const expected = res.status === 404 ? "NOT_FOUND" : "PERMISSION_DENIED";
      return answer && answer.success === false && answer.errorCode === expected ? { status: "absent" } : { status: "unavailable" };
    } catch {
      return { status: "unavailable" };
    }
  }
  if (!res.ok) return { status: "unavailable" };
  let json: { success?: boolean; data?: unknown; owner?: string; programName?: string; acl?: unknown };
  try {
    json = (await storageResponseJson(res)) as typeof json;
  } catch (error) {
    return { status: error instanceof StorageResponseTooLarge ? "absent" : "unavailable" };
  }
  if (!json || typeof json !== "object" || !json.success) return { status: "unavailable" };
  const data = json.data;
  return data != null && typeof data === "object" && !Array.isArray(data) && boundedJson(data) !== null
    ? { status: "present", record: { data: data as Record<string, unknown>, owner: json.owner, programName: json.programName, acl: json.acl } }
    : { status: "absent" };
}

export async function readAnchorRecord(address: string): Promise<AnchorRecord | null> {
  const read = await readAnchorResult(address);
  return read.status === "present" ? read.record : null;
}

export async function readAnchor(address: string): Promise<Record<string, unknown> | null> {
  return (await readAnchorRecord(address))?.data ?? null;
}

export type OwnedAnchorResolution =
  | { status: "present"; address: string; record: AnchorRecord }
  | { status: "absent" }
  | { status: "indeterminate"; reason: string };

type ProgramCandidate = { storageAddress?: unknown; programName?: unknown };

/** kynesyslabs/node manageNodeCall's answer to a message it does not know (ac8f45f, manageNodeCall.ts:996-1000). */
export const UNKNOWN_NODE_CALL = '{ error: "Unknown message"}';
/** Pinned ac8f45f literal and node2's dated 2026-10-17 structured reply. */
export function isUnknownNodeCall(body: { result?: unknown; response?: unknown }): boolean {
  const response = body.response;
  return body.result === 200 && response === UNKNOWN_NODE_CALL ||
    body.result === 404 && Boolean(response && typeof response === "object" && !Array.isArray(response) &&
      (response as Record<string, unknown>).error === "Unknown message");
}


type RpcCall =
  | { status: "ok"; body: { result?: unknown; response?: unknown } }
  | { status: "failed" }
  | { status: "invalid-json" };

/** One bounded JSON-RPC POST to the node, classified. */
async function rpcCall(headers: Record<string, string>, payload: unknown): Promise<RpcCall> {
  let response: Response;
  try {
    response = await fetch(RPC + "/", {
      method: "POST",
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify(payload),
    });
  } catch {
    return { status: "failed" };
  }
  if (!response.ok) return { status: "failed" };
  try {
    const body = await storageResponseJson(response) as { result?: unknown; response?: unknown } | null;
    return body && typeof body === "object" ? { status: "ok", body } : { status: "invalid-json" };
  } catch {
    return { status: "invalid-json" };
  }
}

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

  const options = { exactMatch: true, limit: 32, offset: 0 };
  let search = await rpcCall({ "content-type": "application/json" }, {
    method: "nodeCall",
    params: [{
      type: "nodeCall",
      message: "searchStoragePrograms",
      sender: null,
      receiver: null,
      timestamp: null,
      data: { query: programName, options },
      extra: "",
    }],
  });
  // The pinned node revision (README "Pinned upstreams") has no searchStoragePrograms nodeCall: it
  // answers an unknown message with result 200 and this literal, and serves the same exact-name
  // search as a read-authenticated gcr_routine. A deployment with the nodeCall answers it directly.
  if (search.status === "ok" && isUnknownNodeCall(search.body)) {
    search = await rpcCall(await gcrAuthHeaders(), {
      method: "gcr_routine",
      params: [{ method: "searchStoragePrograms", params: [programName, options] }],
    });
  }
  if (search.status === "failed") return { status: "indeterminate", reason: "program-name lookup failed" };
  if (search.status === "invalid-json") return { status: "indeterminate", reason: "program-name lookup returned invalid JSON" };
  if (search.body.result !== 200 || !Array.isArray(search.body.response)) {
    return { status: "indeterminate", reason: "program-name lookup returned an invalid response" };
  }
  const candidates = search.body.response as ProgramCandidate[];
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
      const body = await storageResponseJson(read) as {
        success?: boolean;
        data?: Record<string, unknown>;
        owner?: string;
        programName?: string;
      };
      if (
        body.success && body.data != null && typeof body.data === "object" && !Array.isArray(body.data) &&
        boundedJson(body.data) !== null && body.programName === programName
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

/** Unauthenticated, bounded settlement reads; never signs or submits a transaction. */
export async function readSettlementNode(message: "getTxByHash" | "getBlockByNumber", data: Record<string, unknown>): Promise<unknown> {
  const result = await rpcCall({ "content-type": "application/json" }, {
    method: "nodeCall", params: [{ type: "nodeCall", message, data, sender: "", signature: "", extra: "" }],
  });
  return result.status === "ok" && result.body.result === 200 ? result.body.response : null;
}
