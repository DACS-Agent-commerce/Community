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
import { isIP } from "node:net";

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
    const a = address.toLowerCase();
    return (
      a === "::" || a === "::1" || a.startsWith("fc") || a.startsWith("fd") ||
      /^fe[89ab]/.test(a) || a.startsWith("ff") ||
      a.startsWith("::ffff:127.") || a.startsWith("::ffff:10.") ||
      a.startsWith("::ffff:192.168.") || a.startsWith("::ffff:169.254.")
    );
  }
  return true;
}

async function validateOutboundUrl(raw: string): Promise<URL> {
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
  return url;
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

async function readTextLimited(res: Response): Promise<string> {
  const announced = Number(res.headers.get("content-length") ?? 0);
  if (announced > MAX_RESPONSE_BYTES) throw new Error("response too large");
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function fetchJson(url: string): Promise<{ body: unknown; raw: string } | null> {
  try {
    let current = await validateOutboundUrl(url);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const res = await fetch(current, {
        signal: AbortSignal.timeout(15_000),
        redirect: "manual",
        headers: { accept: "application/json" },
      });
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        if (!location || redirects === MAX_REDIRECTS) return null;
        current = await validateOutboundUrl(new URL(location, current).href);
        continue;
      }
      if (!res.ok) return null;
      const raw = await readTextLimited(res);
      return { body: JSON.parse(raw), raw };
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
