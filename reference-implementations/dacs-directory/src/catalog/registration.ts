import type { RegisteredDeal, Registration } from "./types.js";

const CLAIM = /^(?:did:demos:agent:|0x)?[0-9a-fA-F]{64}$/;
const ANCHOR = /^stor-[0-9a-f]{40}$/;

const stringField = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

function parseDeal(v: unknown): RegisteredDeal | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const d = v as Record<string, unknown>;
  const owners = d.owners;
  if (!owners || typeof owners !== "object" || Array.isArray(owners)) return null;
  const o = owners as Record<string, unknown>;
  if (
    !stringField(d.jobId, 160) ||
    !stringField(d.rail, 160) ||
    !stringField(d.buyerBundleRef, 80) ||
    !ANCHOR.test(d.buyerBundleRef) ||
    (d.sellerBundleRef !== undefined &&
      (!stringField(d.sellerBundleRef, 80) || !ANCHOR.test(d.sellerBundleRef))) ||
    !stringField(o.buyer, 256) ||
    !stringField(o.seller, 256) ||
    !CLAIM.test(o.buyer) ||
    !CLAIM.test(o.seller)
  ) return null;
  return {
    jobId: d.jobId,
    rail: d.rail,
    buyerBundleRef: d.buyerBundleRef,
    ...(typeof d.sellerBundleRef === "string" ? { sellerBundleRef: d.sellerBundleRef } : {}),
    owners: { buyer: o.buyer, seller: o.seller },
  };
}

export type RegistrationParseResult =
  | { ok: true; value: Registration }
  | { ok: false; error: string };

export function parseRegistration(v: unknown): RegistrationParseResult {
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return { ok: false, error: "registration must be a JSON object" };
  }
  const b = v as Record<string, unknown>;
  if (!stringField(b.primaryClaim, 256) || !CLAIM.test(b.primaryClaim)) {
    return { ok: false, error: "primaryClaim must be a Demos ed25519 claim" };
  }
  if (!stringField(b.displayName, 100)) {
    return { ok: false, error: "displayName must be 1-100 characters" };
  }
  if (
    !Array.isArray(b.listingAnchors) ||
    b.listingAnchors.length > 32 ||
    !b.listingAnchors.every((a) => typeof a === "string" && ANCHOR.test(a))
  ) {
    return { ok: false, error: "listingAnchors must contain at most 32 storage addresses" };
  }
  if (b.deals !== undefined && (!Array.isArray(b.deals) || b.deals.length > 200)) {
    return { ok: false, error: "deals must be an array with at most 200 entries" };
  }
  const deals = (b.deals as unknown[] | undefined)?.map(parseDeal);
  if (deals?.some((d) => d === null)) {
    return { ok: false, error: "one or more deal entries are malformed" };
  }

  let ownerSignature: Registration["ownerSignature"];
  if (b.ownerSignature !== undefined) {
    const os = b.ownerSignature;
    if (!os || typeof os !== "object" || Array.isArray(os)) {
      return { ok: false, error: "ownerSignature is malformed" };
    }
    const o = os as Record<string, unknown>;
    if (!stringField(o.message, 16_384) || !stringField(o.signature, 512) || !Number.isSafeInteger(o.signedAt)) {
      return { ok: false, error: "ownerSignature is malformed" };
    }
    ownerSignature = { message: o.message, signature: o.signature, signedAt: o.signedAt as number };
  }

  return {
    ok: true,
    value: {
      primaryClaim: b.primaryClaim,
      displayName: b.displayName.trim(),
      listingAnchors: [...new Set(b.listingAnchors as string[])],
      ...(deals ? { deals: deals as RegisteredDeal[] } : {}),
      ...(ownerSignature ? { ownerSignature } : {}),
    },
  };
}
