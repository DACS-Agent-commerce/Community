/**
 * POST /api/dacs/build-listing — everything the wallet flow needs to publish
 * a listing, precomputed server-side:
 *   { claim, serviceId, name, description, rails[], delivery[] }
 * →  identity preimage, then the exact unsigned Listing, then (only after its
 *    wallet signature is verified) a broadcastable anchor transaction.
 *
 * For a new version the client wallet-signs `message`; the server verifies the
 * signature and binds that exact artifact plus its hashes into `tx`. When the same owner/name already holds
 * a verified immutable version, the response carries `exists:true` and no
 * transaction so the client can resume registration without another write.
 * Ownership is intrinsic: the native address uses the seller's next account
 * nonce plus the live empty salt, and readback re-binds owner/name/content.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  assertValidUnicode,
  canonicalize,
  contentHash,
  listingAddress,
  sha256Hex,
} from "./canonical.js";
import { logicalToStorageProgramName } from "@kynesyslabs/dacs/canonical";
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import { isListing, type ListingDraft } from "@kynesyslabs/dacs/artifacts";
import {
  resolveListingPayloadVerificationCapability,
  resolveListingRails,
} from "@/src/sdkListingValidation";
import {
  deriveStorageAddress,
  LIVE_STORAGE_SALT,
  resolveOwnedAnchorByName,
} from "@/src/catalog/chain";
import { StorageResponseTooLarge, storageResponseJson } from "@/src/catalog/artifactLimits";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";
import { listingVersionFloor, loadCatalog, loadRegistrations } from "@/src/catalog/store";
import { registrationMessage } from "@/src/catalog/registrationSig";
import { safePublicEndpoint } from "@/src/catalog/publicEndpoint";
import { verifyStoredListing } from "@/src/catalog/listingVerification";
import { importLegacySignatureValue } from "@/src/catalog/signatureValue";
import { pinnedNodeDeployment } from "@/src/catalog/listingFinality";
import {
  negotiationPhaseForPricing,
  publishableRail,
  PUBLISHABLE_PRICING_KINDS,
  PUBLISHER_IN_CODE_RAIL_DEFINITIONS,
  railAuthorityPermitsPublication,
  RAIL_ID_PATTERN,
  type PublishablePricingKind,
} from "@/src/catalog/listingOptions";

const LISTING_SEPARATOR = "dacs-listing:v1:";
const BUNDLE_SEPARATOR = "dacs-bundle-presentation:v1:";
const PUBLISHABLE_DELIVERY = new Set(["deliver-attested-payload", "deliver-storage-program", "deliver-entitlement"]);
const NONCE_READ_TIMEOUT_MS = 15_000;
const ATTESTED_PAYLOAD_UNSUPPORTED = "This browser publisher cannot prove the seller runtime's exact attested-payload production capability. Publish this delivery type through the current SDK seller runtime.";

const timedOut = (error: unknown): boolean =>
  error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

/**
 * The seller's current account nonce from the node. The reply is byte-bounded
 * before decoding and the nonce must be a non-negative safe integer below
 * MAX_SAFE_INTEGER, so the transaction nonce (this plus one) stays exact.
 * Throws an Error naming the real cause: timeout (also while reading the body),
 * unreachable node, HTTP refusal, oversized, unreadable or non-JSON reply, node
 * error result or invalid nonce.
 */
async function accountNonce(addressHex: string): Promise<number> {
  let res: Response;
  try {
    res = await fetch(RPC + "/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(NONCE_READ_TIMEOUT_MS),
      body: JSON.stringify({
        method: "nodeCall",
        params: [{ type: "nodeCall", message: "getAddressNonce", sender: null, receiver: null, timestamp: null, data: { address: `0x${addressHex}` }, extra: "" }],
      }),
    });
  } catch (error) {
    throw new Error(timedOut(error) ? "the node did not answer in time" : "the node could not be reached");
  }
  if (!res.ok) throw new Error(`the node answered HTTP ${res.status}`);
  let json: { result?: unknown; response?: unknown } | null;
  try {
    json = await storageResponseJson(res) as typeof json;
  } catch (error) {
    if (error instanceof StorageResponseTooLarge) throw new Error("the reply exceeds the byte limit");
    if (error instanceof SyntaxError) throw new Error("the reply is not valid JSON");
    // The deadline also covers the body, so a stall after the headers lands here.
    throw new Error(timedOut(error) ? "the node did not answer in time" : "the reply could not be read");
  }
  if (json?.result !== 200) throw new Error(`the node returned result ${String(json?.result)}`);
  const nonce = json.response;
  if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0 || nonce >= Number.MAX_SAFE_INTEGER) {
    throw new Error("the node returned an invalid account nonce");
  }
  return nonce;
}

export function createBuildListingPost(
  inCodeDefinitions: ReadonlyArray<Omit<(typeof PUBLISHER_IN_CODE_RAIL_DEFINITIONS)[number], "signatureValid"> & { signatureValid: boolean }> = PUBLISHER_IN_CODE_RAIL_DEFINITIONS,
) {
return async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "build-listing", 10, 10 * 60_000) ?? rejectOversizeRequest(req);
  if (blocked) return blocked;
  const body = (await req.json().catch(() => null)) as {
    claim?: string; serviceId?: string; name?: string; description?: string;
    rails?: string[]; delivery?: string[]; category?: string; tags?: string[];
    publicEndpoint?: string; identityPresentedAt?: number; identitySignature?: string;
    listingSignature?: string; listingVersion?: number;
    pricing?: {
      kind?: PublishablePricingKind; amount?: string; currency?: string; unit?: string; minTotal?: string;
      minPct?: number; maxPct?: number; selectionRule?: "lowest-price" | "highest-price" | "first-acceptable";
    };
  } | null;
  const hex = body?.claim?.match(/([0-9a-fA-F]{64})$/)?.[1]?.toLowerCase();
  if (!hex || !body?.serviceId?.trim() || !body?.name?.trim() || !body?.description?.trim()) {
    return NextResponse.json({ error: "need claim, serviceId, name, description" }, { status: 400 });
  }
  if (!/^[a-z0-9-]{1,64}$/.test(body.serviceId.trim())) {
    return NextResponse.json({ error: "serviceId must be a lowercase slug (a-z, 0-9, -)" }, { status: 400 });
  }
  if (body.description.length > 2000) {
    return NextResponse.json({ error: "description exceeds the 2000-char spec cap" }, { status: 400 });
  }
  try { assertValidUnicode(body); } catch { return NextResponse.json({ error: "invalid Unicode" }, { status: 400 }); }
  if (
    !Array.isArray(body.rails) || body.rails.length > 16 ||
    !body.rails.every((v) => typeof v === "string" && v.length <= 128 && RAIL_ID_PATTERN.test(v)) ||
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
  const selectedRail = rails.length === 1 ? publishableRail(rails[0]) : undefined;
  if (!selectedRail || delivery.length !== 1 || !PUBLISHABLE_DELIVERY.has(delivery[0])) {
    return NextResponse.json({ error: "pick one supported payment rail and one delivery method" }, { status: 400 });
  }
  // Refused before any wallet signature is requested: no later request can succeed.
  if (delivery[0] === "deliver-attested-payload") {
    return NextResponse.json({ error: ATTESTED_PAYLOAD_UNSUPPORTED }, { status: 409 });
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
  const nextVersion = Math.max(0, listingVersionFloor(did, serviceId), ...priorVersions) + 1;
  // A retry names the version its signed artifact carries, so it still resolves
  // that version after the catalog has indexed it, instead of allocating the next.
  const requestedVersion = body.listingVersion;
  if (requestedVersion !== undefined && requestedVersion !== nextVersion &&
    !(Number.isSafeInteger(requestedVersion) && priorVersions.includes(requestedVersion))) {
    return NextResponse.json({ error: "listingVersion must be the next version or one this seller already published" }, { status: 400 });
  }
  const listingVersion = requestedVersion ?? nextVersion;

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
  if (!PUBLISHABLE_PRICING_KINDS.includes(pricingKind)) {
    return NextResponse.json({ error: "unsupported pricing model" }, { status: 400 });
  }
  const amount = body.pricing?.amount?.trim() ?? "";
  const currency = body.pricing?.currency?.trim() ?? "";
  const decimal = /^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/;
  if (!decimal.test(amount) || !Number.isFinite(Number(amount)) || Number(amount) <= 0 || !/^[A-Za-z0-9._:-]{1,32}$/.test(currency)) {
    return NextResponse.json({ error: "pricing needs a positive canonical amount and currency" }, { status: 400 });
  }
  if (pricingKind === "negotiable" && (
    !Number.isSafeInteger(body.pricing?.minPct) || !Number.isSafeInteger(body.pricing?.maxPct) ||
    Number(body.pricing?.minPct) < 0 || Number(body.pricing?.minPct) >= 100 || Number(body.pricing?.maxPct) < 0
  )) return NextResponse.json({ error: "negotiation percentages must be nonnegative integers in this publisher profile" }, { status: 400 });
  if (pricingKind === "auction" && body.pricing?.selectionRule && !["lowest-price", "highest-price", "first-acceptable"].includes(body.pricing.selectionRule)) {
    return NextResponse.json({ error: "unsupported auction selection rule" }, { status: 400 });
  }
  const meteredUnit = body.pricing?.unit?.trim() ?? "";
  const minTotal = body.pricing?.minTotal?.trim() ?? "";
  if (pricingKind === "metered" && (!meteredUnit || meteredUnit.length > 64)) {
    return NextResponse.json({ error: "metered pricing needs a unit of at most 64 characters" }, { status: 400 });
  }
  if (pricingKind === "metered" && minTotal && (
    !decimal.test(minTotal) || !Number.isFinite(Number(minTotal)) || Number(minTotal) <= 0
  )) return NextResponse.json({ error: "metered minimum must be a positive canonical amount" }, { status: 400 });

  // LP-6: resolve rail authority before the seller signs anything.
  const payPhase = { kind: selectedRail.phaseKind, parameters: { rail: selectedRail.railId } };
  const acceptedRails = [{ railId: selectedRail.railId }];
  const railResolution = resolveListingRails({
    trustPhase: "PA-1",
    trustPolicyAcceptsPA1: true,
    payPhases: [{ kind: payPhase.kind, rail: payPhase.parameters.rail }],
    acceptedRails,
    registry: { state: "not-used", entries: [], definitions: [] },
    inCodeDefinitions: inCodeDefinitions.map((definition) => ({ ...definition })),
  });
  if (!railAuthorityPermitsPublication(railResolution)) {
    return NextResponse.json(
      {
        error: `listing rail authority is ${railResolution.disposition} (${railResolution.reason}), not verified (DACS-1 LP-6); publication refused`,
        railResolution,
      },
      { status: 409 },
    );
  }

  // A current Listing embeds a separately signed IdentityBundle. The first
  // request returns that preimage; the second includes the wallet signature
  // and receives the exact Listing preimage. Only a third request carrying the
  // Listing signature receives a broadcastable anchor transaction.
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
    return NextResponse.json({ identityMessage, identityPresentedAt, listingVersion });
  }
  const identitySigHex = body.identitySignature.replace(/^(0x)+/i, "");
  // Wallets return hex; CORE §B.7 SIG-6 stores canonical unpadded base64url.
  const identitySignatureValue = importLegacySignatureValue(identitySigHex.toLowerCase(), "lowercase-hex");
  if (!identitySignatureValue) {
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
    ...(pricingKind !== "metered" && body.pricing?.unit?.trim()
      ? { unit: body.pricing.unit.trim().slice(0, 64) }
      : {}),
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
  } : pricingKind === "metered" ? {
    kind: "metered",
    unitPrice: { amount, currency },
    unit: meteredUnit,
    ...(minTotal ? { minTotal: { amount: minTotal, currency } } : {}),
  } : { kind: "fixed", price: pricingTerm };
  const deliverableKind = delivery[0].replace(/^deliver-/, "");
  const deliverable = deliverableKind === "storage-program"
    ? { kind: "storage-program", accessModel: "public" }
    : deliverableKind === "entitlement"
      ? { kind: "entitlement", durationSec: 2_592_000, renewable: false }
      : {
          kind: "attested-payload",
          payloadFormat: "application/json",
          verificationMethod: { kind: "self-signed" },
        };
  const auctionDeadline = identityPresentedAt + 7 * 24 * 60 * 60 * 1000;
  const negotiationKind = negotiationPhaseForPricing(pricingKind);
  const negotiationStep = negotiationKind === "negotiate-rfq"
    ? { kind: negotiationKind, parameters: { maxTurns: 8, timeoutSec: 300, rfqInitiator: "buyer" } }
    : negotiationKind === "negotiate-sealed-envelope"
      ? { kind: negotiationKind, parameters: { commitDeadline: auctionDeadline, revealWindow: 3600, selectionRule: body.pricing?.selectionRule ?? "first-acceptable" } }
      : { kind: negotiationKind };
  const pipeline = [
    negotiationStep,
    { kind: "commit-agreement" },
    payPhase,
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
        presentation: {
          kind: "per-claim",
          signatures: [{ ref: did, signature: identitySignatureValue }],
        },
      },
      displayName: knownSeller?.displayName ?? body.name.trim(),
      ...(publicEndpoint ? { publicEndpoint } : {}),
    },
    offering: { title: body.name.trim(), description: body.description.trim(), category, tags, deliverable },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline,
    pricing,
    acceptedRails,
    terms: {},
    validity: { notBefore: identityPresentedAt, ...(pricingKind === "auction" ? { notAfter: auctionDeadline } : {}) },
  };
  const payloadCapability = await resolveListingPayloadVerificationCapability(
    listing as unknown as ListingDraft,
    "produce",
  );
  if (
    payloadCapability.disposition !== "not-applicable" &&
    payloadCapability.disposition !== "supported"
  ) {
    return NextResponse.json({ error: ATTESTED_PAYLOAD_UNSUPPORTED }, { status: 409 });
  }

  // StorageProgram names are producer-held write inputs, not public resolution
  // keys. This deterministic colon-free encoding lets THIS producer recover a
  // broadcast whose response was lost without pretending consumers can derive
  // the native address from the logical one.
  const programNameFor = (version: number) =>
    logicalToStorageProgramName(listingAddress(did, serviceId, version));
  // Earlier /register versions named the program `dacs1-<base64url(logical
  // address)>`. Those versions are still occupied on chain, so the occupancy
  // check reads both names; new programs are only ever created under the
  // current one.
  const legacyProgramNameFor = (version: number) =>
    `dacs1-${Buffer.from(listingAddress(did, serviceId, version), "utf8").toString("base64url")}`;
  const recoverable = (verified: Awaited<ReturnType<typeof verifyStoredListing>>) => Boolean(
    verified &&
    verified.profile === "dacs-v0.1" &&
    verified.sellerClaim === did &&
    verified.scope.listingId === serviceId &&
    verified.scope.listingVersion === listingVersion,
  );
  // An occupied but invalid version cannot establish a conforming version
  // sequence. Refuse it below; recovery requires a fresh listing ID.
  let programName = programNameFor(listingVersion);
  let resolution = await resolveOwnedAnchorByName(programName, owner);
  if (resolution.status === "absent") {
    const legacyName = legacyProgramNameFor(listingVersion);
    const legacy = await resolveOwnedAnchorByName(legacyName, owner);
    if (legacy.status !== "absent") {
      resolution = legacy;
      if (legacy.status === "present") programName = legacyName;
    }
  }
  const hash = contentHash(listing as Record<string, unknown>);
  const message = LISTING_SEPARATOR + hash; // §B.7 signing preimage, pure ASCII
  let signedCandidate: Record<string, unknown> | undefined;
  if (body.listingSignature !== undefined) {
    if (typeof body.listingSignature !== "string") {
      return NextResponse.json({ error: "listing signature must be a 64-byte Ed25519 signature" }, { status: 400 });
    }
    const listingSigHex = body.listingSignature.replace(/^(0x)+/i, "");
    const listingSignatureValue = importLegacySignatureValue(listingSigHex.toLowerCase(), "lowercase-hex");
    if (!listingSignatureValue) {
      return NextResponse.json({ error: "listing signature must be a 64-byte Ed25519 signature" }, { status: 400 });
    }
    let listingSignatureValid = false;
    try {
      listingSignatureValid = ed25519Verify(
        Buffer.from(message, "utf8"),
        Uint8Array.from(Buffer.from(listingSigHex, "hex")),
        publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex"))),
      );
    } catch { /* malformed signatures fail closed */ }
    signedCandidate = {
      ...listing,
      signature: {
        algorithm: "ed25519",
        signer: did,
        value: listingSignatureValue,
      },
    };
    if (!listingSignatureValid || !isListing(signedCandidate)) {
      return NextResponse.json({ error: "the signed listing failed current SDK validation" }, { status: 400 });
    }
  }

  const logicalAddress = listingAddress(did, serviceId, listingVersion);
  if (resolution.status === "indeterminate") {
    return NextResponse.json(
      { error: `could not safely determine whether this listing version already exists: ${resolution.reason}` },
      { status: 503 },
    );
  }

  let anchorAddress: string;
  let publishedListing: Record<string, unknown> = listing;
  let publishedHash = hash;
  let tx: Record<string, unknown> | null = null;
  const exists = resolution.status === "present";
  if (resolution.status === "present") {
    const verified = await verifyStoredListing(resolution.record.data, resolution.address);
    if (!verified || !recoverable(verified)) {
      return NextResponse.json(
        { error: "the existing owner-bound program does not contain the expected authenticated listing candidate; choose a new Service ID" },
        { status: 409 },
      );
    }
    // Listing versions are immutable. Recover the already-signed artifact and
    // continue registration; never overwrite it with newly generated bytes.
    anchorAddress = resolution.address;
    publishedListing = resolution.record.data;
    publishedHash = verified.contentHash;
  } else {
    // Do not prepare a broadcastable transaction until the wallet has signed
    // the exact artifact returned by the preview response.
    if (!signedCandidate) {
      return NextResponse.json({
        listing,
        message,
        contentHash: hash,
        artifactProfile: "dacs-v0.1",
        logicalAddress,
        programName,
        exists: false,
        tx: null,
        publicationReady: false,
        railResolution,
        payloadCapability,
      });
    }
    // Broadcasting is the seller's irreversible step, so refuse a node outside
    // the pin here rather than after the write (confirm-listing checks again).
    let deployment: Awaited<ReturnType<typeof pinnedNodeDeployment>>;
    try {
      deployment = await pinnedNodeDeployment();
    } catch (error) {
      const cause = error instanceof Error ? error.message : "unknown failure";
      return NextResponse.json({ error: `could not read the Demos node's build and chain (${cause}); no transaction was prepared` }, { status: 503 });
    }
    if (!deployment.ok) {
      return NextResponse.json({ error: `${deployment.reason}; no transaction was prepared` }, { status: 409 });
    }
    let nonce: number;
    try {
      nonce = await accountNonce(hex);
    } catch (error) {
      const cause = error instanceof Error ? error.message : "unknown failure";
      return NextResponse.json({ error: `could not read the account nonce (${cause}); no transaction was prepared` }, { status: 503 });
    }
    const txNonce = nonce + 1;
    anchorAddress = deriveStorageAddress(owner, programName, txNonce, LIVE_STORAGE_SALT);
    const payload = {
      operation: "CREATE_STORAGE_PROGRAM",
      storageAddress: anchorAddress,
      programName,
      encoding: "json",
      data: signedCandidate,
      metadata: {
        logicalAddress,
        contentHash: hash,
        envelopeHash: sha256Hex(canonicalize(signedCandidate)),
      },
      acl: { mode: "public" },
      salt: LIVE_STORAGE_SALT,
      storageLocation: "onchain",
    };
    tx = {
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
    publishedListing = signedCandidate;
  }

  const priorRegistration = loadRegistrations().find((r) => r.primaryClaim === did);
  const recoveredSeller = publishedListing.seller && typeof publishedListing.seller === "object" && !Array.isArray(publishedListing.seller)
    ? publishedListing.seller as Record<string, unknown>
    : null;
  const displayName = typeof recoveredSeller?.displayName === "string"
    ? recoveredSeller.displayName
    : knownSeller?.displayName ?? body.name.trim();
  const registration = {
    primaryClaim: did,
    displayName,
    listingAnchors: [...new Set([
      ...(priorRegistration?.listingAnchors ?? []),
      ...(knownSeller?.listings.map((l) => l.anchor.locator) ?? []),
      anchorAddress,
    ])],
    deals: priorRegistration?.deals ?? [],
    ...(priorRegistration?.bundleBindings ? { bundleBindings: priorRegistration.bundleBindings } : {}),
  };
  const signedAt = Date.now();

  return NextResponse.json({
    listing: publishedListing,
    ...(exists ? {} : { message }),
    contentHash: publishedHash,
    artifactProfile: "dacs-v0.1",
    logicalAddress,
    programName,
    anchorAddress,
    exists,
    tx,
    publicationReady: true,
    railResolution,
    payloadCapability,
    registration: {
      ...registration,
      ownerSignature: {
        message: registrationMessage(registration, signedAt),
        signedAt,
      },
    },
  });
}

}
