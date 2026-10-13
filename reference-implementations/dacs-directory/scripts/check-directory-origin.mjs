import { BlockList, isIP } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Addresses no remote client can reach as this deployment: loopback, unspecified,
// private, shared (CGNAT), and link-local ranges. IPv4-mapped IPv6 literals are
// matched against the IPv4 rules by BlockList.
const NON_PUBLIC_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
]) {
  NON_PUBLIC_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isPublicHost(hostname) {
  const host = hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  const family = isIP(host);
  if (family) return !NON_PUBLIC_ADDRESSES.check(host, family === 6 ? "ipv6" : "ipv4");
  return host !== "localhost" && !host.endsWith(".localhost") && !host.endsWith(".local");
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
  if (!isPublicHost(url.hostname)) {
    throw new Error(`${name} must be a public host, not loopback, private, link-local, or .local: ${url.hostname}`);
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
