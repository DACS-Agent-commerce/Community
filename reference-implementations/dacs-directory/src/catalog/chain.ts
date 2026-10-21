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
import { sha256Hex } from "./canonical.js";
import type { SettlementNotFound } from "./nativePayment.js";
import { VerificationUnavailable } from "./verificationUnavailable.js";

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
 * One storage read, classified. `absent` means the locator is malformed or the
 * node confirms NOT_FOUND; `invalid` means the content cannot be an artifact
 * object. Denied access, transport errors and node failures are `unavailable`,
 * which callers must treat as indeterminate rather than absent (DACS-1 RB-6).
 * Its cause says why: `denied` (the node's structured PERMISSION_DENIED) and
 * `too-large` (over the response or artifact bounds) describe the program as
 * its owner keeps it; `timeout`, `transport` and `node-error` are no answer.
 */
export type AnchorReadUnavailableCause = "timeout" | "transport" | "node-error" | "denied" | "too-large";
export type AnchorRead =
  | { status: "present"; record: AnchorRecord }
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "unavailable"; cause: AnchorReadUnavailableCause };

const transportCause = (error: unknown): AnchorReadUnavailableCause =>
  (error as { name?: unknown } | null)?.name === "TimeoutError" ? "timeout" : "transport";
const bodyCause = (error: unknown): AnchorReadUnavailableCause =>
  error instanceof StorageResponseTooLarge ? "too-large" : "node-error";

export async function readAnchorResult(address: string): Promise<AnchorRead> {
  if (!/^stor-[0-9a-f]{40}$/.test(address)) return { status: "absent" };
  let res: Response;
  try {
    res = await fetch(`${RPC}/storage-program/${address}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    return { status: "unavailable", cause: transportCause(error) };
  }
  // Only the node's own answer is definitive: `{ success: false, errorCode }` with NOT_FOUND on a 404
  // (kynesyslabs/node storageprogram routes). PERMISSION_DENIED on a 403 and any other 4xx, such as a
  // proxy's or a wrong route's, leaves the read incomplete (RB-6).
  if (res.status === 404 || res.status === 403) {
    const expected = res.status === 404 ? "NOT_FOUND" : "PERMISSION_DENIED";
    try {
      const answer = await storageResponseJson(res) as { success?: unknown; errorCode?: unknown } | null;
      if (!answer || answer.success !== false || answer.errorCode !== expected) return { status: "unavailable", cause: "node-error" };
      return res.status === 404 ? { status: "absent" } : { status: "unavailable", cause: "denied" };
    } catch {
      return { status: "unavailable", cause: "node-error" };
    }
  }
  if (!res.ok) return { status: "unavailable", cause: "node-error" };
  let json: { success?: boolean; data?: unknown; owner?: string; programName?: string; acl?: unknown };
  try {
    json = (await storageResponseJson(res)) as typeof json;
  } catch (error) {
    return { status: "unavailable", cause: bodyCause(error) };
  }
  if (!json || typeof json !== "object" || !json.success) return { status: "unavailable", cause: "node-error" };
  const data = json.data;
  if (data == null || typeof data !== "object" || Array.isArray(data)) return { status: "invalid" };
  if (boundedJson(data) === null) return { status: "unavailable", cause: "too-large" };
  return { status: "present", record: { data: data as Record<string, unknown>, owner: json.owner, programName: json.programName, acl: json.acl } };
}

export async function readAnchorRecord(address: string): Promise<AnchorRecord | null> {
  const read = await readAnchorResult(address);
  return read.status === "present" ? read.record : null;
}

/**
 * The evidence graph's artifact reader. A record that is absent, invalid, denied to this
 * reader or over the bounds is in the state its owner keeps it in, and cannot be verified
 * as referenced: null, which refutes only the session citing it, as deleting it would.
 * No answer at all throws VerificationUnavailable, so that session stays undecided.
 */
export async function readArtifact(address: string): Promise<Record<string, unknown> | null> {
  const read = await readAnchorResult(address);
  if (read.status === "present") return read.record.data;
  if (read.status === "unavailable" && read.cause !== "denied" && read.cause !== "too-large") {
    throw new VerificationUnavailable(`the storage read of ${address} had no answer (${read.cause})`, "no-answer");
  }
  return null;
}

/**
 * The evidence graph's payload reader. A payload this anonymous reader is denied is a valid
 * delivery too (DACS-4 §9.6.1 DV-2: a public listing may be delivered privately), so it throws
 * VerificationUnavailable rather than refuting it. Its owner keeps it closed, so that is a
 * lasting state, unlike a read with no answer. An inline payload over the bounds breaks
 * §9.6.1's 128 KB limit and is null.
 */
export async function readPayloadRecord(address: string): Promise<AnchorRecord | null> {
  const read = await readAnchorResult(address);
  if (read.status === "present") return read.record;
  if (read.status === "unavailable" && read.cause === "denied") {
    throw new VerificationUnavailable(`the payload at ${address} is not readable anonymously`, "lasting");
  }
  if (read.status === "unavailable" && read.cause !== "too-large") {
    throw new VerificationUnavailable(`the payload read of ${address} had no answer (${read.cause})`, "no-answer");
  }
  return null;
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
  | { status: "ok"; body: { result?: unknown; response?: unknown; extra?: unknown } }
  | { status: "failed"; cause: string }
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
  } catch (error) {
    return { status: "failed", cause: transportCause(error) };
  }
  if (!response.ok) return { status: "failed", cause: `HTTP ${response.status}` };
  try {
    const body = await storageResponseJson(response) as { result?: unknown; response?: unknown; extra?: unknown } | null;
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
  let aclFilteredSearch = false;
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
  // search as a public gcr_routine. A deployment with the nodeCall answers it directly.
  if (search.status === "ok" && isUnknownNodeCall(search.body)) {
    aclFilteredSearch = true;
    search = await rpcCall({ "content-type": "application/json" }, {
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
  if (records[0]) return { status: "present", address: records[0].address, record: records[0].record };
  // The pinned gcr_routine paginates before ACL filtering and exposes neither the raw
  // page size nor a completion cursor. Even a short or empty page can hide an older
  // owner-bound program. Only a fresh owner-confirmed match can resolve this search.
  if (aclFilteredSearch) {
    return { status: "indeterminate", reason: "ACL-filtered program-name lookup cannot establish absence" };
  }
  return { status: "absent" };
}

/**
 * Unauthenticated, bounded settlement reads; never signs or submits a transaction. Resolves the
 * node's response, or its structured not-found answer, which states how far it checked (node2:
 * result 404, reason not_found, checkedThroughBlock). Any other reply, including a result 200
 * without a response and the pinned source's bare error, is no answer: VerificationUnavailable.
 */
export async function readSettlementNode(message: "getTxByHash" | "getBlockByNumber", data: Record<string, unknown>): Promise<unknown> {
  const result = await rpcCall({ "content-type": "application/json" }, {
    method: "nodeCall", params: [{ type: "nodeCall", message, data, sender: "", signature: "", extra: "" }],
  });
  if (result.status !== "ok") {
    throw new VerificationUnavailable(`the node's ${message} reply ${result.status === "failed" ? `failed (${result.cause})` : "is not JSON"}`, "no-answer");
  }
  const { result: code, response, extra } = result.body;
  if (code === 200 && response !== null && response !== undefined) return response;
  const detail = extra && typeof extra === "object" && !Array.isArray(extra) ? extra as Record<string, unknown> : null;
  if (code === 404 && response === null && detail?.reason === "not_found" && Number.isSafeInteger(detail.checkedThroughBlock)) {
    return { notFound: true, checkedThroughBlock: Number(detail.checkedThroughBlock) } satisfies SettlementNotFound;
  }
  throw new VerificationUnavailable(`the node's ${message} reply has no answer (result ${Number.isSafeInteger(code) ? code : "not a status"})`, "no-answer");
}
