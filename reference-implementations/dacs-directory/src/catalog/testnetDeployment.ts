/**
 * The testnet deployment profile (deploy/testnet): the only environment the
 * systemd units start in. Static settings are checked first, so a refused
 * configuration never contacts a node; both RPC settings must name the same
 * endpoint, and the configured node must serve
 * the pinned chain. The node reports its own chain, so this detects a wrong
 * network rather than authenticating the node (see nodeDeployment.ts).
 */
import { catalogNodeDeployment } from "./listingFinality.js";
import { PINNED_DEMOS_CHAIN_IDENTITY } from "./nodeDeployment.js";

/** The only DACS_DIRECTORY_NETWORK value this profile accepts. */
export const TESTNET_NETWORK = "testnet";

/**
 * Reviewed Demos testnet chain identities, in the form DEMOS_CHAIN_IDENTITY
 * takes. An entry is added by a reviewed source change, never by a setting.
 */
export const TESTNET_CHAIN_IDENTITIES: readonly string[] = [PINNED_DEMOS_CHAIN_IDENTITY];

/** Overall deadline for the startup read of the served chain. */
export const STARTUP_CHAIN_CHECK_TIMEOUT_MS = 30_000;

/** The server/indexer RPC and the RPC browsers use to verify deals. */
const RPC_SETTINGS = ["DEMOS_RPC", "NEXT_PUBLIC_DEMOS_RPC"] as const;
const normalizedRpc = (value: string): string => new URL(value).toString().replace(/\/$/, "");

function rpcRefusal(name: string, value: string | undefined): string | null {
  if (!value?.trim()) return `${name} must name the testnet RPC`;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return `${name} must be an absolute https URL`;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    return `${name} must be a credential-free https URL without query or fragment`;
  }
  if (url.hostname.split(".").some((label) => label.includes("mainnet"))) {
    return `${name} names a mainnet host; this deployment is testnet only`;
  }
  return null;
}

/**
 * Why `env` is not the testnet profile, or null when it is. Refuses a missing
 * or other network label, a missing, insecure or mainnet-named RPC, and a
 * DEMOS_CHAIN_IDENTITY outside TESTNET_CHAIN_IDENTITIES. Reads no network.
 */
export function testnetConfigRefusal(env: Readonly<Record<string, string | undefined>>): string | null {
  const network = env.DACS_DIRECTORY_NETWORK?.trim() ?? "";
  if (network !== TESTNET_NETWORK) {
    return `DACS_DIRECTORY_NETWORK must be "${TESTNET_NETWORK}", not ${JSON.stringify(network.slice(0, 64))}; this deployment is testnet only`;
  }
  for (const name of RPC_SETTINGS) {
    const refusal = rpcRefusal(name, env[name]);
    if (refusal) return refusal;
  }
  if (normalizedRpc(env.DEMOS_RPC!) !== normalizedRpc(env.NEXT_PUBLIC_DEMOS_RPC!)) {
    return "NEXT_PUBLIC_DEMOS_RPC must match DEMOS_RPC; distinct RPCs are not supported by this deployment";
  }
  const identity = env.DEMOS_CHAIN_IDENTITY?.trim().toLowerCase();
  if (identity && !TESTNET_CHAIN_IDENTITIES.includes(identity)) {
    return "DEMOS_CHAIN_IDENTITY is not a reviewed testnet chain identity";
  }
  return null;
}

export type TestnetStartupCheck = { ok: true; chainIdentity: string } | { ok: false; reason: string };

/**
 * The startup gate over this process's environment: the static profile, the
 * compiled manifest's RPC when starting a built app, then
 * the chain the configured node serves, within STARTUP_CHAIN_CHECK_TIMEOUT_MS.
 * Returns the refusal reason instead of throwing; an unreadable node is a
 * refusal whose reason says so.
 */
export async function checkTestnetStartup(readBuiltRpc?: () => Promise<unknown>): Promise<TestnetStartupCheck> {
  const refusal = testnetConfigRefusal(process.env);
  if (refusal) return { ok: false, reason: refusal };
  if (readBuiltRpc) {
    try {
      const builtRpc = await readBuiltRpc();
      if (typeof builtRpc !== "string" || rpcRefusal("built RPC", builtRpc) ||
        normalizedRpc(builtRpc) !== normalizedRpc(process.env.NEXT_PUBLIC_DEMOS_RPC!)) {
        return { ok: false, reason: "built manifest RPC must match NEXT_PUBLIC_DEMOS_RPC; rebuild with the testnet settings" };
      }
    } catch {
      return { ok: false, reason: "could not read the built manifest RPC; build with the testnet settings before starting" };
    }
  }
  try {
    const deployment = await catalogNodeDeployment(AbortSignal.timeout(STARTUP_CHAIN_CHECK_TIMEOUT_MS));
    return deployment.ok ? { ok: true, chainIdentity: deployment.chainIdentity } : { ok: false, reason: deployment.reason };
  } catch (error) {
    return { ok: false, reason: `could not read the Demos node's chain: ${error instanceof Error ? error.message : String(error)}` };
  }
}
