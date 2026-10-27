import { revocationLogicalAddress } from "./listingVerification.js";
/**
 * §6.3.5 well-known crawler — the spec's federation mechanism.
 *
 * Give the catalog a DOMAIN; everything else is discovered and verified:
 *   https://<domain>/.well-known/agent.json          (legacy DACS discovery profile)
 *     → dacs.listings.indexUrl + indexHash           (hash-bound index)
 *       → listings.json                              (sha256 MUST match)
 *         → per-entry on-chain anchors               (read + verified later
 *            by the normal indexer path, incl. entry.contentHash binding)
 *
 * A domain that lies about its index is caught at the hash; a domain that
 * lists anchors it doesn't own is caught by the indexer (listing.agentId
 * must equal the claimed seller). Per-domain failures never poison the pass.
 */
import { isRevocationBinding } from "@kynesyslabs/dacs/artifacts";
import { sha256Hex } from "./canonical.js";
import { sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";
import { boundedPublicHttpsRequest, isPrivateAddress, validatePublicHttpsUrl } from "./boundedHttps.js";
import { verifyBundleBinding } from "./bundleBinding.js";
import { canonicalDemosAgentClaim } from "./claimRef.js";
import { verifyPrimaryClaimSignature } from "./primaryClaimKey.js";
import { canonicalSignatureBytes } from "./signatureValue.js";
import type { BundleBinding, RevocationBinding } from "./types.js";

export { isPrivateAddress } from "./boundedHttps.js";

export interface WellKnownAgent {
  domain: string;
  seller: string;
  displayName?: string;
  listingAnchors: string[];
  /** Complete active rows that may introduce offers; other anchors are withdrawal carriage only. */
  activeListingAnchors: string[];
  /** Per-anchor content hash asserted by the index (checked by the indexer). */
  contentHashes: Record<string, string>;
  revocations: RevocationBinding[];
  /** Authenticates this index's seller/domain; listing ownership is checked separately. */
  withdrawalAuthenticated?: boolean;
  withdrawalHashes?: string[];
  incompleteWithdrawalHashes?: string[];
  withdrawalIndex?: { generatedAt: number; hash: string };
  /** BB-4-verified records from the optional DACS-1 bundle-binding index. */
  bundleBindings: BundleBinding[];
}

interface DacsBlock {
  dacsVersion?: string;
  listings?: { indexUrl?: string; indexHash?: string; publisherSignature?: string };
  bundleBindings?: { indexUrl?: string; indexHash?: string };
}
interface ListingIndex {
  indexVersion?: string;
  generatedAt?: number;
  seller?: string;
  listings?: Array<{
    listingId: string;
    version: number;
    contentHash: string;
    anchor: { kind: string; locator: string };
    summary: { title: string; category: string; tags: string[]; priceHint?: string };
    status: "active" | "revoked";
    revocation?: RevocationBinding;
  }>;
}

/**
 * RB-2: a binding is complete for one Listing tuple only when it names that seller, the
 * logical address derived from its own claim, and a well-formed marker anchor and hash.
 * The binding carries the Listing's exact `presentedBy` bytes, which may hold CF-3 advisory
 * parameters, so identity is the canonical claim; ingest compares those bytes with the
 * verified Listing.
 */
export function bindsListingTuple(
  binding: unknown, seller: string, tuple: { listingId: string; version: number; contentHash: string },
): binding is RevocationBinding {
  // The SDK's RB-2 isRevocationBinding shape, then this index's exact tuple.
  return isRevocationBinding(binding) && sameCanonicalClaimIdentity(binding.sellerPrimaryClaim, seller) &&
    binding.listingId === tuple.listingId && binding.listingVersion === tuple.version &&
    binding.listingContentHash === tuple.contentHash &&
    binding.logicalAddress === revocationLogicalAddress(binding.sellerPrimaryClaim, tuple.listingId, Number(tuple.version)) &&
    binding.markerAnchor?.kind === "storage-program" && typeof binding.markerAnchor.locator === "string" &&
    /^stor-[0-9a-f]{40}$/.test(binding.markerAnchor.locator) && typeof binding.markerContentHash === "string" &&
    /^[0-9a-f]{64}$/.test(binding.markerContentHash);
}

/** A carried binding can resolve a withdrawal even when the surrounding metadata is incomplete. */
function listingIndexRevocation(entry: NonNullable<ListingIndex["listings"]>[number], seller: string): RevocationBinding | null {
  const tuple = { listingId: entry.listingId, version: entry.version, contentHash: entry.contentHash.toLowerCase() };
  return bindsListingTuple(entry.revocation, seller, tuple) ? entry.revocation : null;
}

/** Whether this record completes a withdrawal check; discovery alone grants no authority. */
export function listingIndexEntryIsComplete(value: unknown, seller: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as NonNullable<ListingIndex["listings"]>[number];
  // §6.3.5 rows carry lowercase hex and a DACS-1 URL-safe listingId.
  const hash = typeof entry.contentHash === "string" && /^[0-9a-f]{64}$/.test(entry.contentHash) ? entry.contentHash : null;
  const summary = entry.summary;
  if (typeof entry.listingId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(entry.listingId) ||
      !Number.isSafeInteger(entry.version) || Number(entry.version) < 1 ||
      !hash || !/^[0-9a-f]{64}$/.test(hash) || !entry.anchor || typeof entry.anchor !== "object" || Array.isArray(entry.anchor) ||
      entry.anchor.kind !== "storage-program" ||
      typeof entry.anchor.locator !== "string" || !/^stor-[0-9a-f]{40}$/.test(entry.anchor.locator)) return false;
  // RB-6: an authenticated but malformed record cannot complete a withdrawal check.
  // Validate both statuses against the whole ListingIndexEntry, including optional known fields.
  if (!summary || typeof summary !== "object" || Array.isArray(summary) || typeof summary.title !== "string" ||
      typeof summary.category !== "string" || !Array.isArray(summary.tags) || summary.tags.some(tag => typeof tag !== "string") ||
      (summary.priceHint !== undefined && typeof summary.priceHint !== "string")) return false;
  if (entry.status === "active") return entry.revocation === undefined;
  if (entry.status !== "revoked") return false;
  return listingIndexRevocation(entry, seller) !== null;
}

export const revocationBindingKey = (binding: RevocationBinding): string => JSON.stringify([
  binding.sellerPrimaryClaim, binding.listingId, binding.listingVersion, binding.listingContentHash,
  binding.logicalAddress, binding.markerAnchor.kind, binding.markerAnchor.locator, binding.markerContentHash,
]);

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

export type WithdrawalProvenance = "publisher-signature" | "operator-pin";

/** Server configuration only: public domain submissions never authorize a seller. */
export function wellKnownWithdrawalProvenance(agent: WellKnownAgent): WithdrawalProvenance | undefined {
  if (agent.withdrawalAuthenticated) return "publisher-signature";
  try {
    const pins: unknown = JSON.parse(process.env.DACS_WITHDRAWAL_SOURCE_PINS ?? "{}");
    if (!pins || typeof pins !== "object" || Array.isArray(pins)) return;
    const domain = normalizeSubmittedDomain(agent.domain);
    for (const [source, seller] of Object.entries(pins)) {
      if (seller === agent.seller && normalizeSubmittedDomain(source) === domain) return "operator-pin";
    }
  } catch { /* Invalid configuration grants no source authority. */ }
}

/** Sign these exact UTF-8 bytes; the signature lives outside the hashed index. */
export function wellKnownWithdrawalMessage(domain: string, indexHash: string): string {
  return `dacs-directory withdrawal-index:v1\ndomain:${normalizeSubmittedDomain(domain)}\nindex:sha256-${indexHash.replace(/^sha256-/, "").toLowerCase()}`;
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

export async function crawlDomain(domain: string, deps: { fetchJson?: typeof fetchJson; validateUrl?: typeof validatePublicHttpsUrl } = {}): Promise<WellKnownAgent | { domain: string; error: string }> {
  const fetchDocument = deps.fetchJson ?? fetchJson;
  let base: string;
  try {
    base = normalizeSubmittedDomain(domain);
    await (deps.validateUrl ?? validatePublicHttpsUrl)(base);
  } catch (e) {
    return { domain, error: e instanceof Error ? e.message : "invalid domain" };
  }
  const card = await fetchDocument(`${base}/.well-known/agent.json`);
  if (!card) return { domain, error: "no .well-known/agent.json" };

  const dacs = (card.body as { dacs?: DacsBlock })?.dacs;
  if (dacs?.dacsVersion !== "1" || !dacs.listings?.indexUrl) return { domain, error: "agent.json has no supported dacs.listings block" };

  const index = await fetchDocument(dacs.listings.indexUrl);
  if (!index) return { domain, error: `listings index unreachable (${dacs.listings.indexUrl})` };

  // The hash IS the binding (§6.3.5): "sha256-<hex>" over the index bytes.
  const expected = (typeof dacs.listings.indexHash === "string" ? dacs.listings.indexHash : "").replace(/^sha256-/, "").toLowerCase();
  const actual = sha256Hex(index.raw);
  if (!expected || actual !== expected) {
    return { domain, error: `indexHash mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` };
  }

  const idx = index.body && typeof index.body === "object" && !Array.isArray(index.body)
    ? index.body as ListingIndex : null;
  if (!idx || idx.indexVersion !== "1" || !Number.isSafeInteger(idx.generatedAt) || Number(idx.generatedAt) <= 0) {
    return { domain, error: "listings.json has an invalid version or generatedAt" };
  }
  const seller = typeof idx.seller === "string" && /^did:demos:agent:[0-9a-fA-F]{64}$/.test(idx.seller)
    ? canonicalDemosAgentClaim(idx.seller) : null;
  if (!seller) {
    return { domain, error: "listings.json has no canonical Demos seller claim" };
  }
  if (!Array.isArray(idx.listings) || idx.listings.length > 200) {
    return { domain, error: "listings.json must contain at most 200 listings" };
  }
  const signature = dacs.listings.publisherSignature;
  const signatureBytes = typeof signature === "string" && signature.length === 86 ? canonicalSignatureBytes(signature) : null;
  const withdrawalAuthenticated = signatureBytes !== null &&
    Boolean(await verifyPrimaryClaimSignature(Buffer.from(wellKnownWithdrawalMessage(base, actual), "utf8"),
      signatureBytes, seller, "ed25519"));

  const listingAnchors: string[] = [];
  const activeListingAnchors: string[] = [];
  const withdrawalOnlyAnchors = new Set<string>();
  const revocations: RevocationBinding[] = [];
  const withdrawalHashes: string[] = [];
  const incompleteWithdrawalHashes: string[] = [];
  const contentHashes: Record<string, string> = {};
  for (const entry of idx.listings ?? []) {
    if (!entry || typeof entry !== "object") { incompleteWithdrawalHashes.push("*"); continue; }
    const hash = typeof entry.contentHash === "string" && /^[0-9a-fA-F]{64}$/.test(entry.contentHash)
      ? entry.contentHash.toLowerCase() : null;
    if (hash) withdrawalHashes.push(hash);
    const locator = entry.anchor?.locator;
    const complete = listingIndexEntryIsComplete(entry, seller);
    // Conflicting rows in one index cannot lend active eligibility to each other.
    if (typeof locator === "string" && (!complete || entry.status !== "active")) withdrawalOnlyAnchors.add(locator);
    if (
      typeof entry.listingId !== "string" || !entry.listingId || !Number.isSafeInteger(entry.version) || Number(entry.version) < 1 ||
      typeof locator !== "string" || !/^stor-[0-9a-f]{40}$/.test(locator) || !hash
    ) { incompleteWithdrawalHashes.push(hash ?? "*"); continue; }
    if (!complete) incompleteWithdrawalHashes.push(hash);
    if (complete && entry.status === "active") activeListingAnchors.push(locator);
    // Completeness gates active discovery and absence/holds, never marker resolution.
    // Ingest still verifies the listing publisher, owner, tuple, marker hash and signature.
    const binding = listingIndexRevocation(entry, seller);
    if (binding) revocations.push(binding);
    listingAnchors.push(locator);
    contentHashes[locator] = hash;
  }
  const rawName = (card.body as { name?: unknown })?.name;
  const displayName = typeof rawName === "string" && rawName.length <= 100 ? rawName : undefined;
  const bundleBindings: BundleBinding[] = [];
  const agent = { domain: base, seller, displayName, listingAnchors: [...new Set(listingAnchors)],
    activeListingAnchors: [...new Set(activeListingAnchors)].filter(anchor => !withdrawalOnlyAnchors.has(anchor)), contentHashes,
    revocations: [...new Map(revocations.map((binding) => [revocationBindingKey(binding), binding])).values()], bundleBindings,
    withdrawalAuthenticated, withdrawalHashes: [...new Set(withdrawalHashes)], incompleteWithdrawalHashes: [...new Set(incompleteWithdrawalHashes)],
    withdrawalIndex: { generatedAt: Number(idx.generatedAt), hash: actual } };
  if (dacs.bundleBindings?.indexUrl) {
    const bindingIndex = await fetchDocument(dacs.bundleBindings.indexUrl);
    if (!bindingIndex) return agent;
    const expectedBindingHash = (typeof dacs.bundleBindings.indexHash === "string" ? dacs.bundleBindings.indexHash : "").replace(/^sha256-/, "").toLowerCase();
    const actualBindingHash = sha256Hex(bindingIndex.raw);
    if (!expectedBindingHash || actualBindingHash !== expectedBindingHash) {
      return agent;
    }
    const carried = (bindingIndex.body as { bindings?: unknown })?.bindings;
    if (!Array.isArray(carried) || carried.length > 256) {
      return agent;
    }
    const verified = await Promise.all(carried.map((binding) => verifyBundleBinding(binding)));
    for (const binding of verified) if (binding) bundleBindings.push(binding);
  }
  return agent;
}

export async function crawlDomains(domains: string[], deps: Parameters<typeof crawlDomain>[1] = {}): Promise<{
  agents: WellKnownAgent[];
  errors: Array<{ domain: string; error: string }>;
}> {
  const agents: WellKnownAgent[] = [];
  const errors: Array<{ domain: string; error: string }> = [];
  for (let i = 0; i < domains.length; i += 5) {
    const batch = await Promise.all(domains.slice(i, i + 5).map((domain) => crawlDomain(domain, deps)));
    for (const r of batch) {
      if ("error" in r) errors.push(r);
      else agents.push(r);
    }
  }
  return { agents, errors };
}
