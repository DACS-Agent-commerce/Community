/**
 * Seller-kit Listings and an in-memory Demos node for contract tests.
 *
 * The Listing has the shape dacs-sdk main 9d820e0f0fea0d9d34c6c0a2b521c18badfb4fee
 * builds in packages/dacs-client/src/dacs/listing.mjs (blob 12412563)
 * buildUnsignedIdentityBundle / buildListingDraft, signed as
 * attachIdentityPresentation / attachListingSignature sign it (raw Ed25519,
 * Base64URL). No real network, chain or key is involved.
 */
import { canonicalize, contentHash, sha256Hex } from "@kynesyslabs/dacs/canonical";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { PINNED_DEMOS_CHAIN_IDENTITY, PINNED_DEMOS_NODE_BUILDS } from "../../src/catalog/nodeDeployment.js";

export type Artifact = Record<string, unknown>;

export interface KitSeller {
  claim: string;
  /** The storage-program owner form of the claim's key. */
  owner: string;
  sign(separator: string, hash: string): string;
}

/** A deterministic seller key; `seedByte` only selects distinct test identities. */
export function kitSeller(seedByte: number): KitSeller {
  const seed = Uint8Array.from(Buffer.alloc(32, seedByte));
  const privateKey = privateKeyFromSeed(seed);
  const hex = Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex");
  return {
    claim: `did:demos:agent:${hex}`,
    owner: `0x${hex}`,
    sign: (separator, hash) => Buffer.from(ed25519Sign(Buffer.from(separator + hash, "utf8"), privateKey)).toString("base64url"),
  };
}

function kitIdentityBundle(seller: KitSeller, presentedAt: number): Artifact {
  const bundle = {
    bundleVersion: "1",
    presentedBy: seller.claim,
    presentedAt,
    sessionNonce: sha256Hex(`dacs-chatgpt-plugin:contract-session:${seller.claim}:${presentedAt}`),
    claims: [{ ref: seller.claim }],
  };
  const signature = seller.sign("dacs-bundle-presentation:v1:", sha256Hex(canonicalize(bundle)));
  return { ...bundle, presentation: { kind: "per-claim", signatures: [{ ref: seller.claim, signature }] } };
}

export interface KitListingOptions {
  listingId?: string;
  listingVersion?: number;
  publicEndpoint?: string;
  title?: string;
  /** Replace the kit pipeline and accepted rails (for unsupported variants). */
  pipeline?: Artifact[];
  acceptedRails?: Artifact[];
  /** Validity start; the kit uses the current time. */
  notBefore: number;
}

/** A signed Listing as the seller kit publishes it. */
export function kitListing(seller: KitSeller, options: KitListingOptions): Artifact {
  const draft = {
    dacsVersion: "1",
    listingVersion: options.listingVersion ?? 1,
    listingId: options.listingId ?? "kit-market-report",
    requiredCapabilities: ["SR-1", "SR-2"],
    seller: {
      identity: kitIdentityBundle(seller, options.notBefore - 1_000),
      displayName: "Kit Seller",
      publicEndpoint: options.publicEndpoint ?? "https://seller.example.org/agent",
    },
    offering: {
      title: options.title ?? "Kit market report",
      description: "A market report delivered as a public storage program.",
      category: "services.market-report",
      tags: ["kit", "report"],
      deliverable: { kind: "storage-program", schemaUrl: "urn:dacs-chatgpt-plugin:v0.1:seller-defined-delivery", accessModel: "public" },
    },
    buyerRequirement: { requirementVersion: "1", required: [], preferredPresentation: "any" },
    pipeline: options.pipeline ?? [
      { kind: "negotiate-fixed-price" },
      { kind: "commit-payee-bound-agreement" },
      { kind: "pay-dem", parameters: { rail: "demos-native:DEM" } },
      { kind: "deliver-storage-program" },
    ],
    pricing: { kind: "fixed", price: { amount: "2.5", currency: "DEM" } },
    acceptedRails: options.acceptedRails ?? [{ railId: "demos-native:DEM", railVersion: 1 }],
    terms: { deadlineSecAfterCommit: 3600, cancellationPolicy: "pre-commit", transcriptDisclosurePolicy: "encrypted-anchored-recommended" },
    validity: { notBefore: options.notBefore },
  };
  return { ...draft, signature: { algorithm: "ed25519", signer: seller.claim, value: seller.sign("dacs-listing:v1:", contentHash(draft)) } };
}

/** A DACS-1 §6.3.5 revocation marker for `listing`, signed by `signer`. */
export function revocationMarker(signer: KitSeller, listing: Artifact, revokedAt: number): Artifact {
  const scope = {
    listingId: listing.listingId,
    listingVersion: listing.listingVersion,
    listingContentHash: contentHash(listing),
    revokedAt,
  };
  return { ...scope, signature: { algorithm: "ed25519", signer: signer.claim, value: signer.sign("dacs-revocation:v1:", contentHash(scope)) } };
}

/** `stor-` locator `n`, as a node would assign one. */
export const locator = (n: number): string => `stor-${n.toString(16).padStart(40, "0")}`;

/**
 * An in-memory Demos node answering the calls the Directory makes: storage
 * programs by locator and the chain-identity and network-info node calls.
 */
export class FixtureNode {
  readonly programs = new Map<string, { owner: string; data: Artifact }>();
  chainIdentity = PINNED_DEMOS_CHAIN_IDENTITY;
  /** When set, every call answers 503 as an unreachable node would. */
  down = false;
  storageReads = 0;

  anchor(at: string, owner: string, data: Artifact): void {
    this.programs.set(at, { owner, data });
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (this.down) return new Response("unavailable", { status: 503 });
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    if (path.startsWith("/storage-program/")) {
      this.storageReads += 1;
      const program = this.programs.get(path.slice("/storage-program/".length));
      return program
        ? Response.json({ success: true, owner: program.owner, programName: "opaque", data: program.data })
        : Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
    }
    const call = (JSON.parse(String(init?.body ?? "{}")) as { params?: Array<{ message?: string; data?: { blockNumber?: number } }> }).params?.[0];
    if (call?.message === "getNetworkInfo") {
      return Response.json({ result: 200, response: { nodeVersion: { commit: PINNED_DEMOS_NODE_BUILDS[0], dirty: false } } });
    }
    // Deployed nodes answer block zero with an error; block one names the chain.
    if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 0) return Response.json({ result: 400, response: "error" });
    if (call?.message === "getBlockByNumber" && call.data?.blockNumber === 1) {
      return Response.json({
        result: 200,
        response: { id: 2, number: 1, status: "confirmed", hash: "12".repeat(32), content: { previousHash: this.chainIdentity, timestamp: 1 } },
      });
    }
    return Response.json({ result: 200, response: [] });
  };
}
