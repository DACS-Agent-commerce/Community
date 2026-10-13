/**
 * Browser subset used by the SDK's pure verification modules: `isIP`, which
 * the SDK's DACS-1 DCR-2 hostname check uses to refuse IP literals.
 */
const IPV4_SEGMENT = "(?:[0-9]|[1-9][0-9]|1[0-9][0-9]|2[0-4][0-9]|25[0-5])";
// Node's own dotted-decimal IPv4 grammar (lib/internal/net.js).
const IPV4 = new RegExp(`^(?:${IPV4_SEGMENT}\\.){3}${IPV4_SEGMENT}$`);

export function isIPv4(value: string): boolean {
  return IPV4.test(value);
}

export function isIPv6(value: string): boolean {
  if (typeof value !== "string" || !value.includes(":")) return false;
  // Node accepts a scope zone suffix; the WHATWG host parser does not.
  const zone = value.indexOf("%");
  const address = zone < 0 ? value : value.slice(0, zone);
  if (zone >= 0 && !/^%[^%\s]+$/.test(value.slice(zone))) return false;
  if (/[^0-9A-Fa-f:.]/.test(address)) return false;
  try {
    new URL(`http://[${address}]/`);
    return true;
  } catch {
    return false;
  }
}

export function isIP(value: string): 0 | 4 | 6 {
  if (typeof value !== "string") return 0;
  return isIPv4(value) ? 4 : isIPv6(value) ? 6 : 0;
}
