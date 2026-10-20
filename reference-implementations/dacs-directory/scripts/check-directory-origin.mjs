import { realpathSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { fileURLToPath } from "node:url";

// The tables below mirror upstream registries; test/fixtures/origin-policy-sources.json
// records the pinned copies they were checked against, and the deliberate deviations.

// IPv4 space this deployment can't be served from: every block in the IANA IPv4
// Special-Purpose Address Registry, plus multicast and the deprecated 6to4 relay
// anycast block. The registry's globally reachable rows (PCP and TURN anycast
// inside 192.0.0.0/24, AS112, AMT) are protocol addresses, not hosting space, so
// this fails closed and rejects them with the rest.
export const NON_PUBLIC_IPV4_SUBNETS = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
// IPv6 literals must be global unicast (2000::/3). That rejects loopback,
// unspecified, IPv4-mapped, IPv4-compatible, NAT64, discard-only, ULA, link-local,
// site-local, and multicast. Inside 2000::/3 the documentation, IETF-protocol
// (including Teredo), 6to4 and Direct Delegation AS112 blocks are rejected too.
// Like the IPv4 table this fails closed: the globally reachable exceptions inside
// 2001::/23 are rejected with it.
export const GLOBAL_UNICAST_IPV6_SUBNETS = [["2000::", 3]];
export const NON_PUBLIC_IPV6_SUBNETS = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
];

// IANA Special-Use Domain Names that can't name a public origin (each with its
// subdomains; `arpa` covers home.arpa, resolver.arpa, service.arpa, ipv4only.arpa,
// 6tisch.arpa, eap.arpa, eap-noob.arpa and the reverse-mapping zones), plus the
// private-use `internal` TLD and the conventional `localdomain`.
export const NON_PUBLIC_SUFFIXES = [
  "localhost",
  "local",
  "test",
  "invalid",
  "onion",
  "alt",
  "arpa",
  "internal",
  "localdomain",
];
// RFC 6761 §6.5 documentation names. Rejected in production; CI's placeholder
// origin uses one, so its check passes --allow-documentation-names.
export const DOCUMENTATION_SUFFIXES = ["example", "example.com", "example.net", "example.org"];

// Fetch Standard "bad ports": browsers refuse to fetch HTTP(S) on these.
export const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95,
  101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179,
  389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601,
  636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

function blockList(family, subnets) {
  const list = new BlockList();
  for (const [network, prefix] of subnets) list.addSubnet(network, prefix, family);
  return list;
}

const NON_PUBLIC_IPV4 = blockList("ipv4", NON_PUBLIC_IPV4_SUBNETS);
const GLOBAL_UNICAST_IPV6 = blockList("ipv6", GLOBAL_UNICAST_IPV6_SUBNETS);
const NON_PUBLIC_IPV6 = blockList("ipv6", NON_PUBLIC_IPV6_SUBNETS);

function isPublicAddress(address, family) {
  if (family === 4) return !NON_PUBLIC_IPV4.check(address, "ipv4");
  return GLOBAL_UNICAST_IPV6.check(address, "ipv6") && !NON_PUBLIC_IPV6.check(address, "ipv6");
}

function hasSuffix(name, suffixes) {
  return suffixes.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function isPublicHost(hostname, { allowDocumentationNames }) {
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  const family = isIP(host);
  if (family) return isPublicAddress(host, family);
  // One trailing dot is a fully qualified name; any other empty label is malformed.
  // A single-label name only resolves through local search domains.
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.includes("")) return false;
  const name = labels.join(".");
  if (hasSuffix(name, NON_PUBLIC_SUFFIXES)) return false;
  return allowDocumentationNames || !hasSuffix(name, DOCUMENTATION_SUFFIXES);
}

export function httpsOrigin(env, name, { allowDocumentationNames = false } = {}) {
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
  if (url.port !== "" && BAD_PORTS.has(Number(url.port))) {
    throw new Error(`${name} must not use port ${url.port}, which browsers refuse to fetch`);
  }
  if (!isPublicHost(url.hostname, { allowDocumentationNames })) {
    throw new Error(
      `${name} must be a public host (a multi-label DNS name that is not special-use, or a `
      + `global unicast IP address), not a local, private, or special-use one: ${url.hostname}`,
    );
  }
  // directory.example. is a different origin from the directory.example it is served on.
  if (url.hostname.endsWith(".")) throw new Error(`${name} must not end its host name with a dot`);
  // The app uses the raw value (minus one trailing slash), not this parsed origin.
  if (env[name] !== url.origin && env[name] !== `${url.origin}/`) {
    throw new Error(`${name} must be written exactly as its origin: ${url.origin}`);
  }
  return url.origin;
}

export function checkDirectoryOrigin({ env = process.env, allowDocumentationNames = false } = {}) {
  const directoryOrigin = httpsOrigin(env, "NEXT_PUBLIC_DIRECTORY_URL", { allowDocumentationNames });
  return allowDocumentationNames
    ? `Directory origin valid (documentation names allowed; not a production check): ${directoryOrigin}`
    : `Production directory origin valid: ${directoryOrigin}`;
}

async function main() {
  try {
    const allowDocumentationNames = process.argv.slice(2).includes("--allow-documentation-names");
    console.log(checkDirectoryOrigin({ allowDocumentationNames }));
  } catch (error) {
    console.error(`[deployment config] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

// Compare real paths: import.meta.url is resolved, argv[1] may run through a symlink.
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();
