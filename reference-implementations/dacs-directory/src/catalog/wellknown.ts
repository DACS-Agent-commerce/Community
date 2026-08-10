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
import { boundedPublicHttpsRequest, isPrivateAddress, validatePublicHttpsUrl } from "./boundedHttps.js";
import { verifyBundleBinding } from "./bundleBinding.js";
import type { BundleBinding } from "./types.js";

export { isPrivateAddress } from "./boundedHttps.js";

export interface WellKnownAgent {
  domain: string;
  seller: string;
  displayName?: string;
  listingAnchors: string[];
  /** Per-anchor content hash asserted by the index (checked by the indexer). */
  contentHashes: Record<string, string>;
  /** BB-4-verified records from the optional DACS-1 bundle-binding index. */
  bundleBindings: BundleBinding[];
}

interface DacsBlock {
  dacsVersion?: string;
  listings?: { indexUrl?: string; indexHash?: string };
  bundleBindings?: { indexUrl?: string; indexHash?: string };
}
interface ListingIndex {
  indexVersion?: string;
  generatedAt?: number;
  seller?: string;
  listings?: Array<{
    listingId?: string;
    version?: number;
    contentHash?: string;
    anchor?: { kind?: string; locator?: string };
    summary?: { title?: string };
    status?: "active" | "revoked";
  }>;
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

async function fetchJson(url: string): Promise<{ body: unknown; raw: string } | null> {
  try {
    const response = await boundedPublicHttpsRequest(url, { method: "GET", accept: "application/json" });
    if (response.status < 200 || response.status >= 300) return null;
    const raw = response.body.toString("utf8");
    return { body: JSON.parse(raw), raw };
  } catch {
    return null;
  }
}

export async function crawlDomain(domain: string): Promise<WellKnownAgent | { domain: string; error: string }> {
  let base: string;
  try {
    base = normalizeSubmittedDomain(domain);
    await validatePublicHttpsUrl(base);
  } catch (e) {
    return { domain, error: e instanceof Error ? e.message : "invalid domain" };
  }
  const card = await fetchJson(`${base}/.well-known/agent.json`);
  if (!card) return { domain, error: "no .well-known/agent.json" };

  const dacs = (card.body as { dacs?: DacsBlock })?.dacs;
  if (dacs?.dacsVersion !== "1" || !dacs.listings?.indexUrl) return { domain, error: "agent.json has no supported dacs.listings block" };

  const index = await fetchJson(dacs.listings.indexUrl);
  if (!index) return { domain, error: `listings index unreachable (${dacs.listings.indexUrl})` };

  // The hash IS the binding (§6.3.5): "sha256-<hex>" over the index bytes.
  const expected = (dacs.listings.indexHash ?? "").replace(/^sha256-/, "").toLowerCase();
  const actual = sha256Hex(index.raw);
  if (!expected || actual !== expected) {
    return { domain, error: `indexHash mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` };
  }

  const idx = index.body as ListingIndex;
  if (idx.indexVersion !== "1" || !Number.isSafeInteger(idx.generatedAt) || Number(idx.generatedAt) <= 0) {
    return { domain, error: "listings.json has an invalid version or generatedAt" };
  }
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
      entry.status === "revoked" || !entry.listingId || !Number.isSafeInteger(entry.version) || Number(entry.version) < 1 ||
      !locator || !/^stor-[0-9a-f]{40}$/.test(locator) ||
      !entry.contentHash || !/^[0-9a-fA-F]{64}$/.test(entry.contentHash)
    ) continue;
    listingAnchors.push(locator);
    contentHashes[locator] = entry.contentHash.toLowerCase();
  }
  const rawName = (card.body as { name?: unknown })?.name;
  const displayName = typeof rawName === "string" && rawName.length <= 100 ? rawName : undefined;
  const bundleBindings: BundleBinding[] = [];
  if (dacs.bundleBindings?.indexUrl) {
    const bindingIndex = await fetchJson(dacs.bundleBindings.indexUrl);
    if (!bindingIndex) return { domain, error: `bundle-binding index unreachable (${dacs.bundleBindings.indexUrl})` };
    const expectedBindingHash = (dacs.bundleBindings.indexHash ?? "").replace(/^sha256-/, "").toLowerCase();
    const actualBindingHash = sha256Hex(bindingIndex.raw);
    if (!expectedBindingHash || actualBindingHash !== expectedBindingHash) {
      return { domain, error: `bundle-binding indexHash mismatch (expected ${expectedBindingHash.slice(0, 12)}…, got ${actualBindingHash.slice(0, 12)}…)` };
    }
    const carried = (bindingIndex.body as { bindings?: unknown })?.bindings;
    if (!Array.isArray(carried) || carried.length > 256) {
      return { domain, error: "bundle-binding index must contain at most 256 records" };
    }
    const verified = await Promise.all(carried.map(verifyBundleBinding));
    for (const binding of verified) if (binding) bundleBindings.push(binding);
  }
  return { domain, seller, displayName, listingAnchors, contentHashes, bundleBindings };
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
