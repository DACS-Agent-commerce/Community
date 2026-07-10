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
import { deriveAnchorAddress, readAnchor } from "@/src/catalog/chain";
import { rateLimit, rejectOversizeRequest } from "@/src/catalog/security";
import { loadCatalog, loadRegistrations } from "@/src/catalog/store";
import { registrationMessage } from "@/src/catalog/registrationSig";

const LISTING_SEPARATOR = "dacs-listing:v1:";
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
  if (rails.length === 0 || delivery.length === 0) {
    return NextResponse.json({ error: "pick at least one payment rail and one delivery method" }, { status: 400 });
  }

  const did = `did:demos:agent:${hex}`;
  const owner = `0x${hex}`;
  const serviceId = body.serviceId.trim();
  const knownSeller = loadCatalog().sellers.find((s) => s.primaryClaim === did);
  const priorVersions = knownSeller?.listings
    .filter((l) => l.listingId === serviceId)
    .map((l) => l.version) ?? [];
  const listingVersion = (priorVersions.length ? Math.max(...priorVersions) : 0) + 1;

  const category = (body.category ?? "services.other").trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,64}$/.test(category)) {
    return NextResponse.json({ error: "category must be dot-notation (e.g. services.code-review)" }, { status: 400 });
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 16 ||
    !body.tags.every((t) => typeof t === "string" && t.length <= 64))) {
    return NextResponse.json({ error: "tags must contain at most 16 values of 64 characters" }, { status: 400 });
  }
  const tags = (body.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const listing = {
    listingId: serviceId,
    listingVersion,
    agentId: did,
    serviceId,
    name: body.name.trim(),
    description: body.description.trim(),
    // Spec offering fields (normative Listing §6) — the SDK's MVP validator
    // tolerates them; the catalog reads them for search/filtering.
    category,
    tags,
    claimRequirements: [] as unknown[],
    supportedNegotiation: ["negotiate-fixed-price"],
    supportedPaymentRails: rails,
    supportedDelivery: delivery,
  };
  const hash = contentHash(listing as Record<string, unknown>);
  const message = LISTING_SEPARATOR + hash; // §B.7 signing preimage, pure ASCII

  const programName = `dacs1:listing:${did}:${serviceId}:v${listingVersion}`;
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
