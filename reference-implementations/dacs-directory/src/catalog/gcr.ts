/**
 * Narrow authenticated GCR identity resolution used by both routes and CLI.
 * It implements only the read-auth protocol needed by getIdentities, avoiding
 * the Demos client's unrelated multichain dependency tree.
 *
 * `gcr_routine getIdentities` requires timestamp-bound auth headers
 * (identity / timestamp / signature over sha256(`${identity}:${timestamp}`),
 * per demosdk's rpcCall). We sign them with a throwaway indexer keypair using
 * the SDK's pure ed25519 — no funds, no registration, just a valid signature.
 * Returns the same `{ result, response }` shape as the client path.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Pure vendored subpaths only; no substrate client dependency.
import {
  ed25519Sign,
  privateKeyFromSeed,
  publicKeyFromSeed,
  rawPublicKey,
} from "@kynesyslabs/dacs/crypto";
import { sha256Hex } from "@kynesyslabs/dacs/canonical";

const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");
const SEED_PATH = join(process.env.DACS_DIRECTORY_DATA ?? join(process.cwd(), "data"), ".indexer-seed");

function indexerSeed(): Uint8Array {
  if (existsSync(SEED_PATH)) return Uint8Array.from(Buffer.from(readFileSync(SEED_PATH, "utf8").trim(), "hex"));
  const seed = randomBytes(32);
  mkdirSync(dirname(SEED_PATH), { recursive: true });
  writeFileSync(SEED_PATH, seed.toString("hex") + "\n", { mode: 0o600 });
  return Uint8Array.from(seed);
}

async function authHeaders(): Promise<Record<string, string>> {
  const seed = indexerSeed();
  const priv = privateKeyFromSeed(seed);
  const pubHex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  const identity = `ed25519:0x${pubHex}`;
  const timestamp = Date.now().toString();
  const message = sha256Hex(`${identity}:${timestamp}`);
  const signature = Buffer.from(await ed25519Sign(Buffer.from(message, "utf8"), priv)).toString("hex");
  return {
    "Content-Type": "application/json",
    identity,
    signature: `0x${signature}`,
    timestamp,
  };
}

/** Raw GCR identity payload for a Demos address (bare hex). */
export async function gcrGetIdentities(addressHex: string): Promise<unknown> {
  const res = await fetch(RPC + "/", {
    method: "POST",
    headers: await authHeaders(),
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      method: "gcr_routine",
      params: [{ method: "getIdentities", params: [addressHex.replace(/^0x/, "")] }],
    }),
  });
  const json = (await res.json().catch(() => null)) as { result?: number; response?: unknown } | null;
  if (json?.result !== 200) throw new Error(`gcr_routine getIdentities → HTTP ${res.status} / result ${json?.result}`);
  return json;
}
