/**
 * §6.3.5 well-known crawler — the spec's federation mechanism.
 *
 * Give the catalog a DOMAIN; everything else is discovered and verified:
 *   https://<domain>/.well-known/agent.json          (A2A card + dacs block)
 *     → dacs.listings.indexUrl + indexHash           (hash-bound index)
 *       → listings.json                              (sha256 MUST match)
 *         → per-entry on-chain anchors               (read + verified later
 *            by the normal indexer path, incl. entry.contentHash binding)
 *
 * A domain that lies about its index is caught at the hash; a domain that
 * lists anchors it doesn't own is caught by the indexer (listing.agentId
 * must equal the claimed seller). Per-domain failures never poison the pass.
 */
import { sha256Hex } from "@kynesyslabs/dacs/canonical";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

export interface WellKnownAgent {
  domain: string;
  seller: string;
  displayName?: string;
  listingAnchors: string[];
  /** Per-anchor content hash asserted by the index (checked by the indexer). */
  contentHashes: Record<string, string>;
}

interface DacsBlock {
  dacsVersion?: string;
  listings?: { indexUrl?: string; indexHash?: string };
}
interface ListingIndex {
  indexVersion?: string;
  seller?: string;
  listings?: Array<{
    listingId?: string;
    contentHash?: string;
    anchor?: { kind?: string; locator?: string };
    summary?: { title?: string };
  }>;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 3;

function ipv6Words(address: string): number[] | null {
  let input = address.toLowerCase().split("%", 1)[0];
  const dotted = input.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return null;
    input = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${
      ((octets[2] << 8) | octets[3]).toString(16)
    }`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => half ? half.split(":").map((word) => Number.parseInt(word, 16)) : [];
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if ([...left, ...right].some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  return zeros >= 1 ? [...left, ...Array<number>(zeros).fill(0), ...right] : null;
}

/** Reject non-global address ranges before every outbound well-known fetch. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return (
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      p[0] >= 224
    );
  }
  if (isIP(address) === 6) {
    const words = ipv6Words(address);
    if (!words) return true;
    // IPv4-mapped addresses inherit the embedded IPv4 policy regardless of
    // whether the resolver renders the tail in dotted or hexadecimal form.
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return isPrivateAddress(
        `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`,
      );
    }
    // Public IPv6 is global-unicast 2000::/3, excluding IETF/documentation
    // assignments and transition space that can tunnel an unchecked IPv4.
    if ((words[0] & 0xe000) !== 0x2000) return true;
    if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) return true; // 2001::/23
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true; // documentation
    if (words[0] === 0x2002) return true; // 6to4
    if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return true; // documentation
    return false;
  }
  return true;
}

interface VettedUrl {
  url: URL;
  /** The specific resolved address the caller MUST connect to. */
  ip: string;
}

/**
 * Vet an outbound URL and PIN the address we will connect to. We resolve DNS,
 * reject if any record is non-public, then hand back one vetted IP. Callers
 * connect to that exact IP (via the node:https `lookup` hook below), which
 * closes the DNS-rebinding window between this check and the socket connect
 * (TOCTOU): a resolver cannot answer "public" here and "169.254.169.254" at
 * fetch time, because fetch never re-resolves.
 */
async function validateOutboundUrl(raw: string): Promise<VettedUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("well-known URLs must use public HTTPS on port 443");
  }
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("local hostnames are not allowed");
  }
  const resolved = await lookup(url.hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some((r) => isPrivateAddress(r.address))) {
    throw new Error("well-known URL resolves to a non-public address");
  }
  return { url, ip: resolved[0].address };
}

export function normalizeSubmittedDomain(domain: string): string {
  const raw = domain.includes("://") ? domain : `https://${domain}`;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" || url.username || url.password ||
    (url.port && url.port !== "443") ||
    (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash
  ) throw new Error("submit a public HTTPS hostname, without a path, query, or custom port");
  return url.origin;
}

/**
 * Force the socket to the pre-vetted IP while TLS/SNI and the Host header stay
 * the real hostname (so certificate validation is unaffected). This is what
 * pins the connection to the address `validateOutboundUrl` approved.
 */
function pinnedLookup(ip: string): LookupFunction {
  const family = isIP(ip) || 4;
  return function (_hostname: string, options: unknown, callback?: unknown) {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: unknown,
      family?: number,
    ) => void;
    const wantsAll =
      typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (wantsAll) cb(null, [{ address: ip, family }], undefined);
    else cb(null, ip, family);
  } as unknown as LookupFunction;
}

interface RawResponse {
  status: number;
  location: string | null;
  body: string;
}

/** Single GET to a vetted URL, connecting only to the pinned IP; size-capped. */
function httpsGetPinned(url: URL, ip: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method: "GET",
        lookup: pinnedLookup(ip),
        servername: url.hostname,
        headers: { accept: "application/json", host: url.host },
        timeout: 15_000,
      },
      (res) => {
        const announced = Number(res.headers["content-length"] ?? 0);
        if (announced > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error("response too large"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            res.destroy();
            reject(new Error("response too large"));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          const loc = res.headers.location;
          resolve({
            status: res.statusCode ?? 0,
            location: Array.isArray(loc) ? loc[0] ?? null : loc ?? null,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function fetchJson(url: string): Promise<{ body: unknown; raw: string } | null> {
  try {
    let current = await validateOutboundUrl(url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await httpsGetPinned(current.url, current.ip);
      if (res.status >= 300 && res.status < 400) {
        if (!res.location || redirects === MAX_REDIRECTS) return null;
        // Re-vet AND re-pin the redirect target before following it.
        current = await validateOutboundUrl(new URL(res.location, current.url).href);
        continue;
      }
      if (res.status < 200 || res.status >= 300) return null;
      return { body: JSON.parse(res.body), raw: res.body };
    }
    return null;
  } catch {
    return null;
  }
}

export async function crawlDomain(domain: string): Promise<WellKnownAgent | { domain: string; error: string }> {
  let base: string;
  try {
    base = normalizeSubmittedDomain(domain);
    await validateOutboundUrl(base);
  } catch (e) {
    return { domain, error: e instanceof Error ? e.message : "invalid domain" };
  }
  const card = await fetchJson(`${base}/.well-known/agent.json`);
  if (!card) return { domain, error: "no .well-known/agent.json" };

  const dacs = (card.body as { dacs?: DacsBlock })?.dacs;
  if (!dacs?.listings?.indexUrl) return { domain, error: "agent.json has no dacs.listings block" };

  const index = await fetchJson(dacs.listings.indexUrl);
  if (!index) return { domain, error: `listings index unreachable (${dacs.listings.indexUrl})` };

  // The hash IS the binding (§6.3.5): "sha256-<hex>" over the index bytes.
  const expected = (dacs.listings.indexHash ?? "").replace(/^sha256-/, "").toLowerCase();
  const actual = sha256Hex(index.raw);
  if (!expected || actual !== expected) {
    return { domain, error: `indexHash mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` };
  }

  const idx = index.body as ListingIndex;
  const seller = idx.seller;
  if (!seller || !/^did:demos:agent:[0-9a-fA-F]{64}$/.test(seller)) {
    return { domain, error: "listings.json has no canonical Demos seller claim" };
  }
  if (!Array.isArray(idx.listings) || idx.listings.length > 200) {
    return { domain, error: "listings.json must contain at most 200 listings" };
  }

  const listingAnchors: string[] = [];
  const contentHashes: Record<string, string> = {};
  for (const entry of idx.listings ?? []) {
    const locator = entry.anchor?.locator;
    if (
      !locator || !/^stor-[0-9a-f]{40}$/.test(locator) ||
      !entry.contentHash || !/^[0-9a-fA-F]{64}$/.test(entry.contentHash)
    ) continue;
    listingAnchors.push(locator);
    contentHashes[locator] = entry.contentHash.toLowerCase();
  }
  const rawName = (card.body as { name?: unknown })?.name;
  const displayName = typeof rawName === "string" && rawName.length <= 100 ? rawName : undefined;
  return { domain, seller, displayName, listingAnchors, contentHashes };
}

export async function crawlDomains(domains: string[]): Promise<{
  agents: WellKnownAgent[];
  errors: Array<{ domain: string; error: string }>;
}> {
  const agents: WellKnownAgent[] = [];
  const errors: Array<{ domain: string; error: string }> = [];
  for (let i = 0; i < domains.length; i += 5) {
    const batch = await Promise.all(domains.slice(i, i + 5).map(crawlDomain));
    for (const r of batch) {
      if ("error" in r) errors.push(r);
      else agents.push(r);
    }
  }
  return { agents, errors };
}
