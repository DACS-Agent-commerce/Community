/**
 * Two-stage SDK-current Listing builder.
 *
 * Stage 1 returns the IdentityBundle presentation message. Stage 2 receives
 * that wallet signature and returns the final Listing message plus an immutable
 * CREATE_STORAGE_PROGRAM transaction carrying the normative logical address.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  contentHash,
  listingAddress,
  logicalToStorageProgramName,
} from "@kynesyslabs/dacs/canonical";
import { identityBundleHash } from "@kynesyslabs/dacs/identity";
import type { IdentityBundle, ListingDraft } from "@kynesyslabs/dacs/artifacts";
import { deriveAnchorAddress, readAnchor } from "@/src/catalog/chain";
import { rateLimit, readJsonBody } from "@/src/catalog/security";
import {
  canonicalProgramOwner,
  loadCatalog,
  loadRegistrations,
  loadScanState,
} from "@/src/catalog/store";
import { registrationMessage } from "@/src/catalog/registrationSig";

const LISTING_SEPARATOR = "dacs-listing:v1:";
const IDENTITY_SEPARATOR = "dacs-bundle-presentation:v1:";
const RPC = (process.env.DEMOS_RPC ?? "https://demosnode.discus.sh/").replace(/\/$/, "");

const RAILS = {
  "dem:default": { phase: "pay-dem" as const, defaultCurrency: "DEM" },
  "x402:default": { phase: "pay-x402" as const, defaultCurrency: "USDC" },
};

type DeliveryId =
  | "deliver-attested-payload"
  | "deliver-storage-program"
  | "deliver-entitlement";

interface BuildBody {
  claim?: string;
  serviceId?: string;
  name?: string;
  description?: string;
  rails?: string[];
  delivery?: string[];
  category?: string;
  tags?: string[];
  priceAmount?: string;
  currency?: string;
  presentedAt?: number;
  identitySignature?: string;
}

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

function canonicalSignature(value: string | undefined): string | null {
  if (!value) return null;
  const withoutPrefix = value.replace(/^(0x)+/i, "");
  if (/^[0-9a-fA-F]{128}$/.test(withoutPrefix)) {
    return Buffer.from(withoutPrefix, "hex").toString("base64url");
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 64 && bytes.toString("base64url") === value ? value : null;
  } catch {
    return null;
  }
}

function nextListingVersion(owner: string, listingId: string): number {
  const versions = Object.values(loadScanState().anchors ?? {})
    .filter((anchor) =>
      anchor.kind === "listing" &&
      canonicalProgramOwner(anchor.owner) === canonicalProgramOwner(owner) &&
      (anchor.data?.listingId === listingId || anchor.data?.serviceId === listingId))
    .map((anchor) => anchor.data?.listingVersion ?? 1)
    .filter((version): version is number => Number.isSafeInteger(version) && Number(version) >= 1);
  return (versions.length > 0 ? Math.max(...versions) : 0) + 1;
}

function deliverableFor(delivery: DeliveryId): ListingDraft["offering"]["deliverable"] {
  if (delivery === "deliver-storage-program") {
    return { kind: "storage-program", accessModel: "public" };
  }
  if (delivery === "deliver-entitlement") {
    return { kind: "entitlement", durationSec: 30 * 24 * 60 * 60, renewable: true };
  }
  return {
    kind: "attested-payload",
    payloadFormat: "application/octet-stream",
    verificationMethod: { kind: "self-signed" },
  };
}

export async function POST(req: NextRequest) {
  const blocked = rateLimit(req, "build-listing", 10, 10 * 60_000);
  if (blocked) return blocked;
  const bodyRead = await readJsonBody<BuildBody>(req);
  if (!bodyRead.ok) return bodyRead.response;
  const body = bodyRead.value;

  const hex = body?.claim?.match(/^(?:did:demos:agent:|0x)?([0-9a-fA-F]{64})$/)?.[1]?.toLowerCase();
  if (!hex || !body?.serviceId?.trim() || !body?.name?.trim() || !body?.description?.trim()) {
    return NextResponse.json({ error: "need claim, serviceId, name, description" }, { status: 400 });
  }
  const serviceId = body.serviceId.trim();
  if (!/^[a-z0-9-]{1,64}$/.test(serviceId)) {
    return NextResponse.json({ error: "serviceId must be a lowercase slug (a-z, 0-9, -)" }, { status: 400 });
  }
  if (body.description.length > 2000 || body.name.length > 200) {
    return NextResponse.json({ error: "listing text exceeds the specification limit" }, { status: 400 });
  }
  if (!Array.isArray(body.rails) || body.rails.length !== 1 || !(body.rails[0] in RAILS)) {
    return NextResponse.json({ error: "choose exactly one supported payment method" }, { status: 400 });
  }
  const delivery = body.delivery?.[0] as DeliveryId | undefined;
  if (!delivery || body.delivery?.length !== 1 || ![
    "deliver-attested-payload",
    "deliver-storage-program",
    "deliver-entitlement",
  ].includes(delivery)) {
    return NextResponse.json({ error: "choose exactly one supported delivery method" }, { status: 400 });
  }
  const category = (body.category ?? "services.other").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,64}$/.test(category)) {
    return NextResponse.json({ error: "category must be dot-notation (e.g. services.code-review)" }, { status: 400 });
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 16 ||
    !body.tags.every((tag) => typeof tag === "string" && tag.length <= 64))) {
    return NextResponse.json({ error: "tags must contain at most 16 values of 64 characters" }, { status: 400 });
  }
  const priceAmount = body.priceAmount?.trim() ?? "";
  const currency = (body.currency?.trim() || RAILS[body.rails[0] as keyof typeof RAILS].defaultCurrency).toUpperCase();
  if (!/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/.test(priceAmount) || Number(priceAmount) <= 0 || !/^[A-Z0-9][A-Z0-9._-]{1,15}$/.test(currency)) {
    return NextResponse.json({ error: "enter a positive canonical price and a valid currency" }, { status: 400 });
  }

  const did = `did:demos:agent:${hex}`;
  const owner = `0x${hex}`;
  const presentedAt = body.presentedAt ?? Date.now();
  if (!Number.isSafeInteger(presentedAt) || Math.abs(Date.now() - presentedAt) > 10 * 60_000) {
    return NextResponse.json({ error: "identity proof timestamp is stale" }, { status: 400 });
  }
  const identityBase = {
    bundleVersion: "1" as const,
    presentedBy: did,
    presentedAt,
    claims: [{ ref: did }],
  };
  const identityForHash: IdentityBundle = {
    ...identityBase,
    presentation: { kind: "per-claim", signatures: [] },
  };
  const identityMessage = IDENTITY_SEPARATOR + identityBundleHash(identityForHash);
  if (!body.identitySignature) {
    return NextResponse.json({ stage: "identity", identityMessage, presentedAt });
  }
  const identitySignature = canonicalSignature(body.identitySignature);
  if (!identitySignature) {
    return NextResponse.json({ error: "identity signature is not canonical Ed25519" }, { status: 400 });
  }
  const identity: IdentityBundle = {
    ...identityBase,
    presentation: {
      kind: "per-claim",
      signatures: [{ ref: did, signature: identitySignature }],
    },
  };

  const knownSeller = loadCatalog().sellers.find((seller) => seller.primaryClaim === did);
  const listingVersion = nextListingVersion(owner, serviceId);
  const railId = body.rails[0] as keyof typeof RAILS;
  const listing: ListingDraft = {
    dacsVersion: "1",
    listingVersion,
    listingId: serviceId,
    seller: {
      identity,
      displayName: knownSeller?.displayName ?? body.name.trim(),
    },
    offering: {
      title: body.name.trim(),
      description: body.description.trim(),
      category,
      tags: (body.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      deliverable: deliverableFor(delivery),
    },
    buyerRequirement: { requirementVersion: "1", required: [] },
    pipeline: [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-agreement" },
      { kind: RAILS[railId].phase, parameters: { rail: railId } },
      { kind: delivery },
    ],
    pricing: { kind: "fixed", price: { amount: priceAmount, currency } },
    acceptedRails: [{ railId, railVersion: 1 }],
    terms: {},
    validity: { notBefore: Date.now() - 60_000 },
  };
  const message = LISTING_SEPARATOR + contentHash(listing as unknown as Record<string, unknown>);
  const logicalAddress = listingAddress(did, serviceId, listingVersion);
  const programName = logicalToStorageProgramName(logicalAddress);
  const nonce = await accountNonce(hex);
  const txNonce = nonce + 1;
  const anchorAddress = deriveAnchorAddress(did, programName, txNonce);
  if (await readAnchor(anchorAddress)) {
    return NextResponse.json({ error: "the next immutable listing slot already exists; reindex before retrying" }, { status: 409 });
  }
  const payload = {
    operation: "CREATE_STORAGE_PROGRAM",
    storageAddress: anchorAddress,
    programName,
    metadata: { logicalAddress },
    encoding: "json",
    data: "__SIGNED_LISTING__",
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
  const priorRegistration = loadRegistrations().find((registration) =>
    canonicalProgramOwner(registration.primaryClaim) === canonicalProgramOwner(did));
  const registration = {
    primaryClaim: did,
    displayName: knownSeller?.displayName ?? body.name.trim(),
    listingAnchors: [...new Set([
      ...(priorRegistration?.listingAnchors ?? []),
      anchorAddress,
    ])],
    deals: priorRegistration?.deals ?? [],
  };
  const signedAt = Date.now();

  return NextResponse.json({
    stage: "listing",
    listing,
    message,
    logicalAddress,
    anchorAddress,
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
