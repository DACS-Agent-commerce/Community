import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function blockList(family, subnets) {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

// IPv4 space no remote client can reach as this deployment: the RFC 6890
// special-use ranges that are not globally reachable, plus multicast, reserved,
// and broadcast. BlockList also matches IPv4-mapped IPv6 literals against these.
const NON_PUBLIC_IPV4 = blockList("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);
const IPV4_MAPPED = blockList("ipv6", [["::ffff:0:0", 96]]);
// IPv6 literals must be global unicast. Everything outside 2000::/3 (loopback,
// unspecified, ULA, link-local, site-local, multicast, NAT64, IPv4-compatible)
// is rejected, as are the documentation, IETF-protocol (including Teredo) and
// 6to4 blocks inside it, which are not routable or tunnel an embedded IPv4.
const GLOBAL_UNICAST_IPV6 = blockList("ipv6", [["2000::", 3]]);
const NON_PUBLIC_IPV6 = blockList("ipv6", [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
]);

// Names reserved for private or host-local use; none can be a public origin.
const LOCAL_ONLY_SUFFIXES = ["localhost", "local", "internal", "home.arpa", "localdomain"];

function isPublicAddress(address, family) {
  if (family === 4) return !NON_PUBLIC_IPV4.check(address, "ipv4");
  if (IPV4_MAPPED.check(address, "ipv6")) return !NON_PUBLIC_IPV4.check(address, "ipv6");
  return GLOBAL_UNICAST_IPV6.check(address, "ipv6") && !NON_PUBLIC_IPV6.check(address, "ipv6");
}

function isPublicHost(hostname) {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(host);
  if (family) return isPublicAddress(host, family);
  // One trailing dot is a fully qualified name; any other empty label is malformed.
  // A single-label name only resolves through local search domains.
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.includes("")) return false;
  const name = labels.join(".");
  return !LOCAL_ONLY_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

export function httpsOrigin(env, name) {
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`${name} is required for a production deployment`);

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }

  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(`${name} must be an origin without credentials, path, query, or fragment`);
  }
  if (url.port === "0") throw new Error(`${name} must not use port 0, which browsers cannot reach`);
  if (!isPublicHost(url.hostname)) {
    throw new Error(
      `${name} must be a public host (a multi-label DNS name or a globally routable IP address), `
      + `not a local, private, or special-use one: ${url.hostname}`,
    );
  }
  // The app uses the raw value (minus one trailing slash), not this parsed origin.
  if (env[name] !== url.origin && env[name] !== `${url.origin}/`) {
    throw new Error(`${name} must be written exactly as its origin: ${url.origin}`);
  }
  return url.origin;
}

export function checkDirectoryOrigin({ env = process.env } = {}) {
  const directoryOrigin = httpsOrigin(env, "NEXT_PUBLIC_DIRECTORY_URL");
  return `Production directory origin valid: ${directoryOrigin}`;
}

async function main() {
  try {
    console.log(checkDirectoryOrigin());
  } catch (error) {
    console.error(`[deployment config] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
