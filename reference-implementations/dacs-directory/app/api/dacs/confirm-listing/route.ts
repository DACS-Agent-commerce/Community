/**
 * POST /api/dacs/confirm-listing — independently read and verify a listing
 * after the wallet broadcasts its StorageProgram transaction.
 *
 * Visibility alone is insufficient: the canonical transaction and its
 * BFT-confirmed block first produce a portable finalized AnchorReceipt. The
 * native address, owner, producer-held program name, listing tuple, content
 * hash, seller, identity presentation and listing signature must then all bind
 * before the browser may register the pointer.
 */
import { NextRequest, NextResponse } from "next/server";
import { listingAddress } from "@kynesyslabs/dacs/canonical";
import { readAnchorRecord } from "@/src/catalog/chain";
import { finalizedListingAnchorReceipt } from "@/src/catalog/listingFinality";
import { verifyListing } from "@/src/catalog/listingVerification";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";

function canonicalOwner(value: string): string | null {
  const hex = value.match(/([0-9a-fA-F]{64})$/)?.[1];
  return hex ? `0x${hex.toLowerCase()}` : null;
}

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "confirm-listing", 60, 10 * 60_000) ?? rejectOversizeRequest(req);
  if (blocked) return blocked;
  const body = await req.json().catch(() => null) as {
    anchorAddress?: unknown;
    programName?: unknown;
    contentHash?: unknown;
    sellerClaim?: unknown;
    listingId?: unknown;
    listingVersion?: unknown;
    transactionRef?: unknown;
  } | null;
  if (
    !body ||
    typeof body.anchorAddress !== "string" || !/^stor-[0-9a-f]{40}$/.test(body.anchorAddress) ||
    typeof body.programName !== "string" || !body.programName || body.programName.length > 512 ||
    typeof body.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(body.contentHash) ||
    typeof body.sellerClaim !== "string" || canonicalOwner(body.sellerClaim) === null ||
    typeof body.listingId !== "string" || !/^[a-z0-9-]{1,64}$/.test(body.listingId) ||
    !Number.isSafeInteger(body.listingVersion) || Number(body.listingVersion) < 1 ||
    (body.transactionRef !== undefined && (
      typeof body.transactionRef !== "string" || !/^[0-9a-fA-F]{64}$/.test(body.transactionRef)
    ))
  ) {
    return NextResponse.json({ error: "invalid listing confirmation coordinates" }, { status: 400 });
  }

  const anchored = await readAnchorRecord(body.anchorAddress);
  if (!anchored) {
    return NextResponse.json({ confirmed: false, state: "not-visible" }, { status: 202 });
  }
  if (
    anchored.programName !== body.programName ||
    canonicalOwner(anchored.owner ?? "") !== canonicalOwner(body.sellerClaim)
  ) {
    return NextResponse.json(
      { confirmed: false, state: "binding-mismatch", error: "anchor coordinates do not bind to this seller publication" },
      { status: 409 },
    );
  }

  const verified = await verifyListing(anchored.data);
  if (
    !verified ||
    verified.profile !== "dacs-v0.1" ||
    verified.contentHash !== body.contentHash ||
    verified.sellerClaim !== body.sellerClaim ||
    verified.scope.listingId !== body.listingId ||
    verified.scope.listingVersion !== body.listingVersion
  ) {
    return NextResponse.json(
      { confirmed: false, state: "verification-failed", error: "anchored listing failed signature, identity, hash, or tuple verification" },
      { status: 409 },
    );
  }

  const logicalAddress = listingAddress(
    body.sellerClaim,
    body.listingId,
    Number(body.listingVersion),
  );
  const finality = await finalizedListingAnchorReceipt({
    anchorAddress: body.anchorAddress,
    logicalAddress,
    programName: body.programName,
    listingContentHash: body.contentHash,
    sellerClaim: body.sellerClaim,
    transactionRef: typeof body.transactionRef === "string"
      ? body.transactionRef.toLowerCase()
      : undefined,
  });
  if (finality.status === "pending") {
    return NextResponse.json(
      { confirmed: false, state: "finality-pending", reason: finality.reason },
      { status: 202 },
    );
  }
  if (finality.status === "rejected") {
    return NextResponse.json(
      { confirmed: false, state: "finality-failed", error: finality.reason },
      { status: 409 },
    );
  }

  return NextResponse.json({
    confirmed: true,
    state: "finalized-and-verified",
    anchorAddress: body.anchorAddress,
    contentHash: verified.contentHash,
    sellerClaim: verified.sellerClaim,
    listingId: body.listingId,
    listingVersion: body.listingVersion,
    anchorReceipt: finality.receipt,
  });
}
