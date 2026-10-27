/**
 * POST /api/dacs/build-listing — everything the wallet flow needs to publish
 * a listing, precomputed server-side:
 *   { claim, serviceId, name, description, rails[], delivery[] }
 * →  identity preimage, then the exact unsigned Listing, then (only after its
 *    wallet signature is verified) a broadcastable anchor transaction.
 * The first response fixes `listingVersion`; every later request sends it back.
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
import {
  listingVersionFloor,
  loadCatalog,
  loadListingPreparation,
  loadRegistrations,
  saveListingPreparation,
  type ListingPreparation,
} from "@/src/catalog/store";
import { registrationMessage } from "@/src/catalog/registrationSig";
import { safePublicEndpoint } from "@/src/catalog/publicEndpoint";
import { verifyStoredListing } from "@/src/catalog/listingVerification";
import { importLegacySignatureValue } from "@/src/catalog/signatureValue";
import { pinnedNodeDeployment } from "@/src/catalog/listingFinality";
import { pinnedChainIdentity } from "@/src/catalog/nodeDeployment";
import { resolveListingVersionOccupancy, type ResolveListingVersion } from "@/src/catalog/listingVersionOccupancy";
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
  if (json?.result !== 200) {
    throw new Error(typeof json?.result === "number" ? `the node returned result ${json.result}` : "the node returned an unexpected result");
  }
  const nonce = json.response;
  if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || nonce < 0 || nonce >= Number.MAX_SAFE_INTEGER) {
    throw new Error("the node returned an invalid account nonce");
  }
  return nonce;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The transaction a retained preparation saved, parsed from its exact stored
 * JSON, when that transaction creates exactly `signedListing`; otherwise
 * undefined. Throws if the stored JSON cannot be parsed.
 */
function savedTransactionCreating(preparation: ListingPreparation, signedListing: Record<string, unknown>): Record<string, unknown> | undefined {
  const tx: unknown = JSON.parse(preparation.transactionJson);
  const payload = isRecord(tx) && isRecord(tx.content) && Array.isArray(tx.content.data) ? tx.content.data[1] : undefined;
  const envelopeHash = isRecord(payload) && isRecord(payload.metadata) ? payload.metadata.envelopeHash : undefined;
  return isRecord(tx) && envelopeHash === sha256Hex(canonicalize(signedListing)) ? tx : undefined;
}

/**
 * The seller display name in a retained preparation's signed Listing, or
 * undefined if it has none. Throws if the stored JSON cannot be parsed.
 */
function preparedDisplayName(preparation: ListingPreparation): string | undefined {
  const tx: unknown = JSON.parse(preparation.transactionJson);
  const payload = isRecord(tx) && isRecord(tx.content) && Array.isArray(tx.content.data) ? tx.content.data[1] : undefined;
  const seller = isRecord(payload) && isRecord(payload.data) && isRecord(payload.data.seller) ? payload.data.seller : undefined;
  return typeof seller?.displayName === "string" ? seller.displayName : undefined;
}

/** Build the staged Listing handler with server-owned rail and logical-occupancy authority. */
export function createBuildListingPost(
  inCodeDefinitions: ReadonlyArray<Omit<(typeof PUBLISHER_IN_CODE_RAIL_DEFINITIONS)[number], "signatureValid"> & { signatureValid: boolean }> = PUBLISHER_IN_CODE_RAIL_DEFINITIONS,
  resolveVersion?: ResolveListingVersion,
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
  // Previews are stateless: an unauthenticated first-stage request must not
  // create mutable state that can block another publisher. Operators must
  // serialize concurrent writes for one seller/listingId (README limitation).
  // The durable floor still counts versions whose catalog rows an admission
  // reset removed. Every version up to `highestKnown` is taken: it is recovered
  // or refused, never created again. Only `nextVersion` may be created.
  const highestKnown = Math.max(0, listingVersionFloor(did, serviceId), ...priorVersions);
  const nextVersion = highestKnown + 1;
  if (!Number.isSafeInteger(nextVersion)) {
    return NextResponse.json({ error: "this Service ID has no next listing version; choose a new Service ID" }, { status: 400 });
  }
  // The first response fixes the version. Later requests must send it back, so
  // a retry resolves that version instead of one worked out again from the catalog.
  const staged = body.identitySignature !== undefined || body.listingSignature !== undefined;
  const listingVersion: unknown = staged ? body.listingVersion : nextVersion;
  if (typeof listingVersion !== "number" || !Number.isSafeInteger(listingVersion) ||
    listingVersion < 1 || listingVersion > nextVersion) {
    return NextResponse.json({ error: "listingVersion must be the version the first step returned or one this seller already published" }, { status: 400 });
  }

  const category = (body.category ?? "services.other").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,64}$/.test(category) || category.split(".").some((part) => !part)) {
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
    !Number.isSafeInteger(identityPresentedAt) || identityPresentedAt > serverNow + 60_000
  )) return NextResponse.json({ error: "identity presentation expired; restart the publish step" }, { status: 409 });
  // A stale signed presentation can still locate a retained attempt/publication;
  // only a fresh presentation may authorize a new preparation below.
  const identityExpired = identityPresentedAt < serverNow - 15 * 60_000;
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
  const logicalAddress = listingAddress(did, serviceId, listingVersion);
  const chainIdentity = pinnedChainIdentity();
  // A prepared version is rebuilt with the display name its seller signed, not
  // the catalog's current one, so an exact signed repeat still matches its
  // saved bytes after the catalog gains, renames or drops this seller.
  const retained = loadListingPreparation(chainIdentity, logicalAddress);
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
      displayName: (retained && preparedDisplayName(retained)) ?? knownSeller?.displayName ?? body.name.trim(),
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

  // StorageProgram names are producer-held write inputs, not public resolution
  // keys. This deterministic colon-free encoding lets THIS producer recover a
  // broadcast whose response was lost without pretending consumers can derive
  // the native address from the logical one.
  const programNameFor = (version: number) =>
    logicalToStorageProgramName(listingAddress(did, serviceId, version));
  // Earlier /register versions named the program `dacs1-<base64url(logical
  // address)>`. Those versions are still occupied on chain, so the occupancy
  // check reads both names; new programs are only ever created under the
  // current one. These are this producer's own names: another producer's
  // programs are not searched. A configured logical resolver strengthens this
  // check; without one the name-based limitation is accepted (see README).
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
  if (resolution.status === "absent" && resolveVersion) {
    resolution = await resolveListingVersionOccupancy(logicalAddress, chainIdentity, owner, resolveVersion);
    if (resolution.status === "present") programName = resolution.record.programName ?? programName;
  }
  const hash = contentHash(listing as Record<string, unknown>);
  const message = LISTING_SEPARATOR + hash; // §B.7 signing preimage, pure ASCII
  const lookupUncertain = (reason: string) => `could not safely determine whether this listing version already exists: ${reason}`;
  const unresolvedPreparation = (anchorAddress: string | undefined, lookupReason?: string) => NextResponse.json({
    error: "this listing version has a saved transaction preparation whose outcome is unresolved; recover its anchor before preparing another create" +
      (lookupReason === undefined ? "" : `; ${lookupUncertain(lookupReason)}`),
    logicalAddress,
    anchorAddress,
  }, { status: 409 });
  // The wallet-signed Listing must match the rebuilt one: a retry is answered, even
  // with only the saved anchor, only after this check passes.
  const checkListingSignature = (listingSignature: unknown): { signedCandidate: Record<string, unknown> } | { refusal: NextResponse } => {
    const malformedSignature = { refusal: NextResponse.json({ error: "listing signature must be a 64-byte Ed25519 signature" }, { status: 400 }) };
    if (typeof listingSignature !== "string") return malformedSignature;
    const listingSigHex = listingSignature.replace(/^(0x)+/i, "");
    const listingSignatureValue = importLegacySignatureValue(listingSigHex.toLowerCase(), "lowercase-hex");
    if (!listingSignatureValue) return malformedSignature;
    let listingSignatureValid = false;
    try {
      listingSignatureValid = ed25519Verify(
        Buffer.from(message, "utf8"),
        Uint8Array.from(Buffer.from(listingSigHex, "hex")),
        publicKeyFromRaw(Uint8Array.from(Buffer.from(hex, "hex"))),
      );
    } catch { /* malformed signatures fail closed */ }
    const signedCandidate: Record<string, unknown> = {
      ...listing,
      signature: {
        algorithm: "ed25519",
        signer: did,
        value: listingSignatureValue,
      },
    };
    if (!listingSignatureValid || !isListing(signedCandidate)) {
      return { refusal: NextResponse.json({ error: "the signed listing failed current SDK validation" }, { status: 400 }) };
    }
    return { signedCandidate };
  };
  if (resolution.status === "indeterminate") {
    // While occupancy is unknown no transaction is released, not even a saved one:
    // the version may be taken. A seller who signed this retry (the identity
    // signature is already verified) learns only the saved anchor; a preview, or
    // a version with no preparation, keeps the 503.
    const saved = body.listingSignature === undefined ? undefined : loadListingPreparation(chainIdentity, logicalAddress);
    if (saved) {
      const checked = checkListingSignature(body.listingSignature);
      return "refusal" in checked ? checked.refusal : unresolvedPreparation(saved.anchorAddress, resolution.reason);
    }
    return NextResponse.json({ error: lookupUncertain(resolution.reason) }, { status: 503 });
  }
  // Empty name indexes and advancing nonces do not establish that a returned
  // create failed. Keep the original attempt across retries and restarts.
  const preparation = resolution.status === "absent" ? retained : undefined;
  // A version slot is write-once: a taken version the resolver cannot find
  // is not free, so no second create may be prepared for it. A version this
  // directory prepared reports its saved anchor below instead.
  if (resolution.status === "absent" && listingVersion !== nextVersion && !preparation) {
    return NextResponse.json(
      { error: "this seller already published this version, but its native binding could not be recovered; no transaction was prepared. Retry once the lookup has caught up, or choose a new Service ID" },
      { status: 409 },
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
    // The rebuilt preview (and any signature over it) plays no part here.
    anchorAddress = resolution.address;
    publishedListing = resolution.record.data;
    publishedHash = verified.contentHash;
  } else {
    if (identityExpired && (body.listingSignature === undefined || !preparation)) {
      return NextResponse.json({ error: "identity presentation expired; restart the publish step" }, { status: 409 });
    }
    // Do not prepare a broadcastable transaction until the wallet has signed
    // the exact artifact returned by the preview response.
    if (body.listingSignature === undefined) {
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
    const checked = checkListingSignature(body.listingSignature);
    if ("refusal" in checked) return checked.refusal;
    const { signedCandidate } = checked;
    // A retained preparation is never replaced. An exact repeat of its signed
    // Listing, for a version nothing else shows as taken, gets the same saved
    // bytes again, so a lost response cannot strand it; that is no second
    // create. Any other retry learns only the saved anchor.
    const savedRelease = (saved: ListingPreparation | undefined) =>
      saved && listingVersion === nextVersion ? savedTransactionCreating(saved, signedCandidate) ?? null : null;
    if (preparation) {
      tx = savedRelease(preparation);
      if (!tx) return unresolvedPreparation(preparation.anchorAddress);
      anchorAddress = preparation.anchorAddress;
    } else {
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
      // Atomic first-writer-wins persistence closes the race between the lookup
      // above and nonce preparation. A failed commit releases no transaction;
      // a lost race releases only the winner's saved bytes, as a repeat would.
      if (!saveListingPreparation(chainIdentity, logicalAddress, { anchorAddress, transactionJson: JSON.stringify(tx) })) {
        const winner = loadListingPreparation(chainIdentity, logicalAddress);
        tx = savedRelease(winner);
        if (!winner || !tx) return unresolvedPreparation(winner?.anchorAddress);
        anchorAddress = winner.anchorAddress;
      }
    }
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
