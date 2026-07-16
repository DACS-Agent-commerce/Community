/**
 * Chain reads for the Next app.
 *
 * Address derivation reproduces Demos StorageProgram's documented
 * sha256(deployer:name:nonce:salt) mapping using the already-vendored DACS
 * canonical primitive. Storage-program READS stay a plain
 * unauthenticated HTTP GET (`/storage-program/{address}`): that is the read
 * path the StorageProgram API prescribes. The app stays free of the Demos
 * client's unrelated multichain dependency tree.
 */
import { sha256Hex } from "@kynesyslabs/dacs/canonical";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

// Callers should supply the observed transaction nonce. The default exists
// only for reading anchors produced by the legacy nonce-0 DACS SDK.
export function deriveAnchorAddress(owner: string, name: string, nonce = 0): string {
  const hex = owner.match(/([0-9a-fA-F]{64})$/)?.[1];
  const deployer = hex ? `0x${hex}` : owner;
  return `stor-${sha256Hex(`${deployer}:${name}:${nonce}:dacs:v1`).slice(0, 40)}`;
}

/** Read an anchored artifact (null if absent / non-public). */
export interface AnchorRecord {
  data: Record<string, unknown>;
  owner?: string;
  programName?: string;
  /** Storage-subsystem write-apply metadata; the SR-2 anchor time source. */
  createdAt?: unknown;
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
      createdAt?: unknown;
    };
    return json?.success && json.data != null
      ? { data: json.data, owner: json.owner, programName: json.programName, createdAt: json.createdAt }
      : null;
  } catch {
    return null;
  }
}

export async function readAnchor(address: string): Promise<Record<string, unknown> | null> {
  return (await readAnchorRecord(address))?.data ?? null;
}
