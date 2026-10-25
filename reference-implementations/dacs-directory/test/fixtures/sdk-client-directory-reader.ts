/**
 * The rules the SDK buyer client applies to this Directory's output, copied
 * from dacs-sdk main 9d820e0f0fea0d9d34c6c0a2b521c18badfb4fee and ported to
 * TypeScript without changing a rule:
 * - packages/dacs-client/src/dacs/directory.mjs (blob c91e7f47): the
 *   patterns, normalizeCatalogObservedAt, projectSummary, search parameters
 *   and the cursor rule;
 * - packages/dacs-client/src/dacs/verification.mjs (blob de51f5bc):
 *   CATALOG_MAX_AGE_MS, checkCatalogObservation, and the Directory and chain
 *   checks of createListingVerifier.verify with its catalog revocation surface;
 * - packages/dacs-client/src/signatures.mjs (blob 6396455c): addressForClaim;
 * - src/agent/listingValidation.ts (blob bfbccc30) checkRevokedSurface: the
 *   catalog-surface steps before the marker read.
 * The SDK reader's own Listing checks and the client's purchaseSupport hold
 * are not Directory output and are not copied.
 */
import { canonicalize, contentHash } from "@kynesyslabs/dacs/canonical";

const HEX64 = /^[0-9a-f]{64}$/;
const LOCATOR = /^stor-[0-9a-f]{40}$/;
const LISTING_ID = /^(?!\.+$)[A-Za-z0-9._~-]{1,128}$/;
const CLAIM = /^did:demos:agent:[0-9a-f]{64}$/;
const CURSOR = /^\d{1,9}$/;
const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const member = (value: unknown, key: string): unknown =>
  value !== null && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
const str = (value: unknown, max = 2000): string | undefined => (typeof value === "string" ? value.slice(0, max) : undefined);
const strings = (value: unknown, count: number): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, count) : [];

export interface ClientSummary {
  listingId: string;
  version: number;
  contentHash: string;
  anchor: { kind: "storage-program"; locator: string };
  seller: { primaryClaim: string; displayName?: string };
  title: string;
  description?: string;
  category?: string;
  tags: string[];
  rails: string[];
  pricingHint: { kind?: string; priceHint?: string; currency?: string; unit?: string };
  publicEndpoint?: string;
  artifactProfile?: string;
  status: "active" | "revoked";
  revocationBinding?: object;
  catalogObservedAt?: number;
}

/** directory.mjs normalizeCatalogObservedAt. */
export function normalizeCatalogObservedAt(value: unknown): number | undefined {
  const observedAt = typeof value === "string" && value.length <= 64 ? Date.parse(value) : value;
  return typeof observedAt === "number" && Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : undefined;
}

/** directory.mjs projectSummary: the only summary fields the client keeps; null rejects the row. */
export function projectSummary(raw: unknown): ClientSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const listingId = member(raw, "listingId");
  const version = member(raw, "version");
  const hash = member(raw, "contentHash");
  const anchor = member(raw, "anchor");
  const seller = member(raw, "seller");
  const offering = member(raw, "offering");
  const status = member(raw, "status");
  if (!LISTING_ID.test(String(listingId ?? "")) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return null;
  if (!HEX64.test(String(hash ?? ""))) return null;
  if (member(anchor, "kind") !== "storage-program" || !LOCATOR.test(String(member(anchor, "locator") ?? ""))) return null;
  if (!CLAIM.test(String(member(seller, "primaryClaim") ?? ""))) return null;
  if (status !== "active" && status !== "revoked") return null;
  const pricing = member(raw, "pricing") ?? {};
  const revocationBinding = member(raw, "revocationBinding");
  return {
    listingId: String(listingId),
    version,
    contentHash: String(hash),
    anchor: { kind: "storage-program", locator: String(member(anchor, "locator")) },
    seller: { primaryClaim: String(member(seller, "primaryClaim")), displayName: str(member(seller, "displayName"), 200) },
    title: str(member(offering, "title"), 200) ?? "",
    description: str(member(offering, "description"), 2000),
    category: str(member(offering, "category"), 64),
    tags: strings(member(offering, "tags"), 16).map((tag) => tag.slice(0, 32)),
    rails: strings(member(offering, "rails"), 8),
    pricingHint: {
      kind: str(member(pricing, "kind"), 32),
      priceHint: str(member(pricing, "priceHint"), 64),
      currency: str(member(pricing, "currency"), 16),
      unit: str(member(pricing, "unit"), 32),
    },
    publicEndpoint: str(member(raw, "publicEndpoint"), 512),
    artifactProfile: str(member(raw, "artifactProfile"), 64),
    status,
    revocationBinding: revocationBinding && typeof revocationBinding === "object" ? revocationBinding : undefined,
    catalogObservedAt: normalizeCatalogObservedAt(member(raw, "catalogObservedAt")),
  };
}

/** directory.mjs search(): the query the client sends to `/api/dacs/listings`. */
export function clientSearchParams(primaryClaim: string, limit = 50): URLSearchParams {
  return new URLSearchParams({ profile: "dacs-v0.1", limit: String(Math.min(Math.max(limit, 1), 50)), primaryClaim });
}

/** directory.mjs search(): a page without a `listings` array is malformed, never an empty result. */
export function parseListingsPage(body: unknown): { listings: ClientSummary[]; rejected: number; cursor?: string; total?: number } {
  const rows = member(body, "listings");
  if (!Array.isArray(rows)) throw new Error("directory listings response is malformed");
  const listings: ClientSummary[] = [];
  let rejected = 0;
  for (const raw of rows.slice(0, 200)) {
    const projected = projectSummary(raw);
    if (projected) listings.push(projected);
    else rejected += 1;
  }
  const cursor = member(body, "cursor");
  const total = member(body, "total");
  return {
    listings,
    rejected,
    cursor: typeof cursor === "string" && CURSOR.test(cursor) ? cursor : undefined,
    total: typeof total === "number" && Number.isSafeInteger(total) ? total : undefined,
  };
}

/** verification.mjs checkCatalogObservation. */
export function checkCatalogObservation(value: unknown, checkedAt: number): { observedAt?: number; fresh: boolean } {
  const observedAt = normalizeCatalogObservedAt(value);
  const fresh = observedAt !== undefined && observedAt <= checkedAt && checkedAt - observedAt <= CATALOG_MAX_AGE_MS;
  return { observedAt, fresh };
}

export interface CatalogSurface {
  kind: "catalog";
  status: "active" | "revoked";
  readStatus: "ok";
  catalogObservedAt?: number;
  binding?: object;
}

export type CatalogSurfaceDisposition = "absent" | "indeterminate" | "marker-required";

/**
 * listingValidation.ts checkRevokedSurface for a catalog surface, up to the
 * marker read: `absent` only for a fresh active row without a binding;
 * `marker-required` when a revoked row's binding names this Listing (the
 * reader then returns `revoked` or `indeterminate`, never `absent`).
 */
export function catalogSurfaceDisposition(surface: CatalogSurface, listing: Record<string, unknown>, now: number): CatalogSurfaceDisposition {
  const observedAt = surface.catalogObservedAt;
  if (observedAt === undefined || observedAt > now || now - observedAt > 24 * 60 * 60 * 1_000) return "indeterminate";
  if (surface.status === "active") return surface.binding ? "indeterminate" : "absent";
  const binding = surface.binding as Record<string, unknown> | undefined;
  if (!binding) return "indeterminate";
  const presentedBy = String(member(member(member(listing, "seller"), "identity"), "presentedBy"));
  const sameTuple = binding.sellerPrimaryClaim === presentedBy && binding.listingId === listing.listingId &&
    binding.listingVersion === listing.listingVersion && binding.listingContentHash === contentHash(listing);
  const logicalAddress = `dacs1-revoked:${encodeURIComponent(presentedBy)}:${String(listing.listingId)}:v${String(listing.listingVersion)}`;
  return sameTuple && binding.logicalAddress === logicalAddress ? "marker-required" : "indeterminate";
}

export interface AdmissionCheck { name: string; ok: boolean }

export interface DirectoryAdmission {
  checks: AdmissionCheck[];
  revocation: CatalogSurfaceDisposition;
  /** Every Directory and chain check passed and the catalog establishes revocation absence. */
  eligible: boolean;
}

/**
 * verification.mjs createListingVerifier.verify, the steps that read the
 * Directory and the chain: summary found, detail hash and coordinates,
 * storage readback equal to the detail and owned by the seller, and a fresh
 * catalog observation feeding the catalog revocation surface.
 */
export function directoryAdmission(input: {
  summary: ClientSummary | null;
  detail: Record<string, unknown>;
  readback: { owner?: string; data: Record<string, unknown> } | null;
  coordinates: { listingId: string; version: number; seller: string };
  checkedAt: number;
}): DirectoryAdmission {
  const { summary, detail, readback, coordinates, checkedAt } = input;
  if (!summary) return { checks: [{ name: "directory-summary", ok: false }], revocation: "indeterminate", eligible: false };
  const detailHash = contentHash(detail);
  const onChain = readback !== null;
  const { observedAt, fresh } = checkCatalogObservation(summary.catalogObservedAt, checkedAt);
  const checks: AdmissionCheck[] = [
    { name: "directory-detail-hash-matches-summary", ok: detailHash === summary.contentHash },
    { name: "directory-coordinates-match", ok: detail.listingId === coordinates.listingId &&
      detail.listingVersion === coordinates.version && member(member(member(detail, "seller"), "identity"), "presentedBy") === coordinates.seller },
    { name: "chain-anchor-present", ok: onChain },
    { name: "chain-readback-equals-directory-detail", ok: onChain && canonicalize(readback.data) === canonicalize(detail) },
    { name: "chain-anchor-owner-is-seller", ok: onChain && readback.owner === `0x${coordinates.seller.slice("did:demos:agent:".length)}` },
    { name: "catalog-observation-fresh", ok: fresh },
  ];
  const surface: CatalogSurface = {
    kind: "catalog", status: summary.status, readStatus: "ok",
    ...(observedAt !== undefined ? { catalogObservedAt: observedAt } : {}),
    ...(summary.revocationBinding ? { binding: summary.revocationBinding } : {}),
  };
  const revocation = catalogSurfaceDisposition(surface, onChain ? readback.data : detail, checkedAt);
  return { checks, revocation, eligible: checks.every((check) => check.ok) && revocation === "absent" };
}
