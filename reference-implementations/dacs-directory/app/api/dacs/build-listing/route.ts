/**
 * POST /api/dacs/build-listing — everything the wallet flow needs to publish
 * a listing, precomputed server-side:
 *   { claim, serviceId, name, description, rails[], delivery[] }
 * →  { listing, message, anchorAddress, exists, tx }
 *
 * The client then: (1) wallet-signs `message` (it IS the §B.7 signing
 * preimage — "dacs-listing:v1:" + contentHash, plain ASCII), (2) drops the
 * signed listing into tx.content.data[1].data, (3) sends the tx through the
 * wallet (sendTransaction signs + broadcasts). Ownership is intrinsic: the
 * anchor address is derived from the SIGNER's account, and the listing's
 * agentId must match it.
 */
import { NextRequest, NextResponse } from "next/server";
import { contentHash } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { deriveAnchorAddress, readAnchor } from "@/src/catalog/chain";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";
import { loadCatalog, loadRegistrations } from "@/src/catalog/store";
import { registrationMessage } from "@/src/catalog/registrationSig";
import { safePublicEndpoint } from "@/src/catalog/publicEndpoint";

const LISTING_SEPARATOR = "dacs-listing:v1:";
const BUNDLE_SEPARATOR = "dacs-bundle-presentation:v1:";
const PUBLISHABLE_RAILS = new Set(["pay-dem", "pay-x402"]);
const PUBLISHABLE_DELIVERY = new Set(["deliver-attested-payload", "deliver-storage-program", "deliver-entitlement"]);
const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

async function accountNonce(addressHex: string): Promise<number> {
  const res = await fetch(RPC + "/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      method: "nodeCall",
      params: [{ type: "nodeCall", message: "getAddressNonce", sender: null, receiver: null, timestamp: null, data: { address: `0x${addressHex}` }, extra: "" }],
    }),
  });
  const json = (await res.json()) as { result?: number; response?: number };
  if (json?.result !== 200) throw new Error("could not fetch account nonce");
  return Number(json.response ?? 0);
}

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "build-listing", 10, 10 * 60_000) ?? rejectOversizeRequest(req);
  if (blocked) return blocked;
  const body = (await req.json().catch(() => null)) as {
    claim?: string; serviceId?: string; name?: string; description?: string;
    rails?: string[]; delivery?: string[]; category?: string; tags?: string[];
    publicEndpoint?: string; identityPresentedAt?: number; identitySignature?: string;
    pricing?: {
      kind?: "fixed" | "negotiable" | "auction"; amount?: string; currency?: string; unit?: string;
      minPct?: number; maxPct?: number; selectionRule?: "lowest-price" | "highest-price" | "first-acceptable";
    };
  } | null;
  const hex = body?.claim?.match(/([0-9a-fA-F]{64})$/)?.[1];
  if (!hex || !body?.serviceId?.trim() || !body?.name?.trim() || !body?.description?.trim()) {
    return NextResponse.json({ error: "need claim, serviceId, name, description" }, { status: 400 });
  }
  if (!/^[a-z0-9-]{1,64}$/.test(body.serviceId.trim())) {
    return NextResponse.json({ error: "serviceId must be a lowercase slug (a-z, 0-9, -)" }, { status: 400 });
  }
  if (body.description.length > 2000) {
    return NextResponse.json({ error: "description exceeds the 2000-char spec cap" }, { status: 400 });
  }
  if (
    !Array.isArray(body.rails) || body.rails.length > 16 ||
    !body.rails.every((v) => typeof v === "string" && /^[a-z0-9:-]{1,128}$/.test(v)) ||
    !Array.isArray(body.delivery) || body.delivery.length > 16 ||
    !body.delivery.every((v) => typeof v === "string" && /^[a-z0-9:-]{1,128}$/.test(v))
  ) {
    return NextResponse.json({ error: "rails/delivery contain invalid identifiers" }, { status: 400 });
  }
  if (body.name.length > 200) {
    return NextResponse.json({ error: "name exceeds 200 characters" }, { status: 400 });
  }
  const rails = body.rails.filter(Boolean);
  const delivery = body.delivery.filter(Boolean);
  if (rails.length !== 1 || delivery.length !== 1 || !PUBLISHABLE_RAILS.has(rails[0]) || !PUBLISHABLE_DELIVERY.has(delivery[0])) {
    return NextResponse.json({ error: "pick one supported payment rail and one delivery method" }, { status: 400 });
  }

  const did = `did:demos:agent:${hex}`;
  const owner = `0x${hex}`;
  const serviceId = body.serviceId.trim();
  const knownSeller = loadCatalog().sellers.find((s) => s.primaryClaim === did);
  const priorVersions = knownSeller?.listings
    .filter((l) => l.listingId === serviceId)
    .map((l) => l.version) ?? [];
  // Stateless by design: an unauthenticated first-stage request must not
  // create mutable state that can block another publisher. Operators must
  // serialize concurrent writes for one seller/listingId (README limitation).
  const listingVersion = Math.max(0, ...priorVersions) + 1;

  const category = (body.category ?? "services.other").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,64}$/.test(category)) {
    return NextResponse.json({ error: "category must be dot-notation (e.g. services.code-review)" }, { status: 400 });
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 16 ||
    !body.tags.every((t) => typeof t === "string" && t.length <= 32))) {
    return NextResponse.json({ error: "tags must contain at most 16 values of 32 characters" }, { status: 400 });
  }
  const tags = (body.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const publicEndpoint = body.publicEndpoint ? safePublicEndpoint(body.publicEndpoint.trim()) : undefined;
  if (body.publicEndpoint && !publicEndpoint) {
    return NextResponse.json({ error: "public endpoint must be a safe HTTPS URL of at most 2048 characters" }, { status: 400 });
  }
  const pricingKind = body.pricing?.kind ?? "fixed";
  if (pricingKind !== "fixed" && pricingKind !== "negotiable" && pricingKind !== "auction") {
    return NextResponse.json({ error: "unsupported pricing model" }, { status: 400 });
  }
  const amount = body.pricing?.amount?.trim() ?? "";
  const currency = body.pricing?.currency?.trim() ?? "";
  const decimal = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
  if (!decimal.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !/^[A-Za-z0-9._:-]{1,32}$/.test(currency)) {
    return NextResponse.json({ error: "pricing needs a positive canonical amount and currency" }, { status: 400 });
  }
  if (pricingKind === "negotiable" && (
    !Number.isFinite(Number(body.pricing?.minPct)) || !Number.isFinite(Number(body.pricing?.maxPct)) ||
    Number(body.pricing?.minPct) < 0 || Number(body.pricing?.minPct) >= 100 || Number(body.pricing?.maxPct) < 0
  )) return NextResponse.json({ error: "negotiation percentages are invalid" }, { status: 400 });
  if (pricingKind === "auction" && body.pricing?.selectionRule && !["lowest-price", "highest-price", "first-acceptable"].includes(body.pricing.selectionRule)) {
    return NextResponse.json({ error: "unsupported auction selection rule" }, { status: 400 });
  }

  // A current Listing embeds a separately signed IdentityBundle. The first
  // request returns that preimage; the second includes the wallet signature
  // and receives the final listing preimage + anchor transaction.
  const serverNow = Date.now();
  const identityPresentedAt = body.identitySignature ? Number(body.identityPresentedAt) : serverNow;
  if (body.identitySignature && (
    !Number.isSafeInteger(identityPresentedAt) || identityPresentedAt < serverNow - 15 * 60_000 || identityPresentedAt > serverNow + 60_000
  )) return NextResponse.json({ error: "identity presentation expired; restart the publish step" }, { status: 409 });
  const identityScope = {
    bundleVersion: "1",
    presentedBy: did,
    presentedAt: identityPresentedAt,
    claims: [{ ref: did }],
  };
  const identityMessage = BUNDLE_SEPARATOR + contentHash(identityScope);
  if (!body.identitySignature) {
    return NextResponse.json({ identityMessage, identityPresentedAt });
  }
  const identitySigHex = body.identitySignature.replace(/^(0x)+/i, "");
  if (!/^[0-9a-fA-F]{128}$/.test(identitySigHex)) {
    return NextResponse.json({ error: "identity signature must be a 64-byte Ed25519 signature" }, { status: 400 });
  }
  let identityOk = false;
  try {
    identityOk = ed25519Verify(
      Buffer.from(identityMessage, "utf8"),
      Uint8Array.from(Buffer.from(identitySigHex, "hex")),
      publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex"))),
    );
  } catch { /* malformed keys/signatures fail closed */ }
  if (!identityOk) return NextResponse.json({ error: "identity presentation signature is invalid" }, { status: 400 });
  const pricingTerm = {
    amount,
    currency,
    ...(body.pricing?.unit?.trim() ? { unit: body.pricing.unit.trim().slice(0, 64) } : {}),
  };
  const pricing = pricingKind === "negotiable" ? {
    kind: "negotiable",
    bandCenter: pricingTerm,
    minPct: Math.max(0, Math.min(99, body.pricing?.minPct ?? 20)),
    maxPct: Math.max(0, body.pricing?.maxPct ?? 20),
  } : pricingKind === "auction" ? {
    kind: "auction",
    reservePrice: pricingTerm,
    selectionRule: body.pricing?.selectionRule ?? "first-acceptable",
  } : { kind: "fixed", price: pricingTerm };
  const deliverableKind = delivery[0].replace(/^deliver-/, "");
  const deliverable = deliverableKind === "storage-program"
    ? { kind: "storage-program", accessModel: "public" }
    : deliverableKind === "entitlement"
      ? { kind: "entitlement", durationSec: 2_592_000, renewable: false }
      : { kind: "attested-payload", payloadFormat: "application/json" };
  const auctionDeadline = identityPresentedAt + 7 * 24 * 60 * 60 * 1000;
  const negotiationStep = pricingKind === "fixed" ? { kind: "negotiate-fixed-price" }
    : pricingKind === "negotiable" ? { kind: "negotiate-rfq", parameters: { maxTurns: 8, timeoutSec: 300, rfqInitiator: "buyer" } }
      : { kind: "negotiate-sealed-envelope", parameters: { commitDeadline: auctionDeadline, revealWindow: 3600, selectionRule: body.pricing?.selectionRule ?? "first-acceptable" } };
  const pipeline = [
    negotiationStep,
    { kind: "commit-agreement" },
    { kind: rails[0], parameters: { rail: rails[0] } },
    { kind: delivery[0] },
  ];
  const listing = {
    dacsVersion: "1",
    listingId: serviceId,
    listingVersion,
    requiredCapabilities: ["SR-2"],
    seller: {
      identity: {
        ...identityScope,
        presentation: { kind: "per-claim", signatures: [{ ref: did, signature: identitySigHex }] },
      },
      displayName: knownSeller?.displayName ?? body.name.trim(),
      ...(publicEndpoint ? { publicEndpoint } : {}),
    },
    offering: { title: body.name.trim(), description: body.description.trim(), category, tags, deliverable },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline,
    pricing,
    acceptedRails: rails.map((railId) => ({ railId })),
    terms: {},
    validity: { notBefore: identityPresentedAt, ...(pricingKind === "auction" ? { notAfter: auctionDeadline } : {}) },
  };
  const hash = contentHash(listing as Record<string, unknown>);
  const message = LISTING_SEPARATOR + hash; // §B.7 signing preimage, pure ASCII

  const logicalAddress = `dacs1:${encodeURIComponent(did)}:${serviceId}:v${listingVersion}`;
  const programName = `dacs1-${Buffer.from(logicalAddress, "utf8").toString("base64url")}`;
  const nonce = await accountNonce(hex);
  const txNonce = nonce + 1;
  const anchorAddress = deriveAnchorAddress(did, programName, txNonce);
  const exists = (await readAnchor(anchorAddress)) != null;

  // Storage-program payload (mirrors demosdk's create/write shapes).
  const payload = exists
    ? { operation: "WRITE_STORAGE", storageAddress: anchorAddress, data: "__SIGNED_LISTING__", encoding: "json" }
    : {
        operation: "CREATE_STORAGE_PROGRAM",
        storageAddress: anchorAddress,
        programName,
        encoding: "json",
        data: "__SIGNED_LISTING__",
        metadata: { logicalAddress },
        acl: { mode: "public" },
        salt: "dacs:v1",
        storageLocation: "onchain",
      };

  const tx = {
    content: {
      type: "storageProgram",
      from: owner,
      to: anchorAddress,
      amount: 0,
      data: ["storageProgram", payload],
      nonce: txNonce,
      timestamp: Date.now(),
      transaction_fee: { network_fee: 0, rpc_fee: 0, additional_fee: 0, rpc_address: null },
    },
    signature: null,
    hash: "",
    status: "",
    blockNumber: null,
  };

  const registration = {
    primaryClaim: did,
    displayName: knownSeller?.displayName ?? body.name.trim(),
    listingAnchors: [...new Set([...(knownSeller?.listings.map((l) => l.anchor.locator) ?? []), anchorAddress])],
    deals: loadRegistrations().find((r) => r.primaryClaim === did)?.deals ?? [],
  };
  const signedAt = Date.now();

  return NextResponse.json({
    listing,
    message,
    artifactProfile: "dacs-v0.1",
    logicalAddress,
    anchorAddress,
    exists,
    tx,
    registration: {
      ...registration,
      ownerSignature: {
        message: registrationMessage(registration, signedAt),
        signedAt,
      },
    },
  });
}
