/**
 * The Demos deployment this release was checked against.
 *
 * A node reports its own build, so this pin detects deployment drift (another
 * chain, another build, uncommitted changes) rather than authenticating the
 * node; consensus is still not verified (see listingFinality.ts). Operators
 * re-pin with DEMOS_CHAIN_IDENTITY and DEMOS_NODE_BUILDS.
 */

/**
 * Block one's `previousHash` on the Demos network node2 served when this
 * release was pinned (block zero answers `error`). node2 has since been reset
 * onto another chain; see the README's DEMOS_CHAIN_IDENTITY row.
 */
export const PINNED_DEMOS_CHAIN_IDENTITY = "83082fbb733d76475a33a9f52fe3700d667a976c2d46bef33a149f47057f7dd4";

/** demos-node-software 0.9.8, the clean commit this release was checked against. */
export const PINNED_DEMOS_NODE_BUILDS = ["61b8e75aa8db5e408c49e1c3a89db4d673f45578"];

export function pinnedChainIdentity(configured = process.env.DEMOS_CHAIN_IDENTITY): string {
  return (configured?.trim() || PINNED_DEMOS_CHAIN_IDENTITY).toLowerCase();
}

/**
 * `<commit>` admits that clean build. A build with uncommitted changes has no
 * reviewable source, so it is refused unless the operator pins that exact
 * observed build as `<commit>+dirty@<builtAt>`.
 */
export function pinnedNodeBuilds(configured = process.env.DEMOS_NODE_BUILDS): string[] {
  const builds = configured?.split(",").map((build) => build.trim()).filter(Boolean) ?? [];
  return builds.length > 0 ? builds : PINNED_DEMOS_NODE_BUILDS;
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

/** The build getNetworkInfo reports, in pin form, or null when it reports none. */
export function reportedNodeBuild(networkInfo: unknown): string | null {
  const version = record(record(networkInfo)?.nodeVersion);
  const commit = typeof version?.commit === "string" ? version.commit : "";
  if (!/^[0-9a-f]{40}$/.test(commit) || typeof version?.dirty !== "boolean") return null;
  return version.dirty ? `${commit}+dirty@${String(version.builtAt ?? "")}` : commit;
}

/** Return why the node's reported build is not pinned, or null when it is. */
export function nodeBuildRejection(networkInfo: unknown, builds = pinnedNodeBuilds()): string | null {
  const build = reportedNodeBuild(networkInfo);
  if (build === null) return "Demos node reports no build identity";
  return builds.includes(build) ? null : `Demos node build ${build} is not pinned`;
}
