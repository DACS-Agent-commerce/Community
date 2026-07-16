import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";

import fixtureReceipt from "../../data/counterparty-evidence/microsoft-counterparty.receipt.json";
import type { SellerRecord } from "./types.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

type SourceObservation = {
  sourceId: string;
  observedAt: string;
  sourceDescriptor: Record<string, JsonValue>;
  query: Record<string, JsonValue>;
  result: Record<string, JsonValue>;
  limitations: string[];
  observationHash: string;
};

export type CounterpartyEvidenceReceipt = {
  schema: string;
  conformanceStatus: string;
  dacsSurface: string[];
  claim: string;
  jobId: string;
  requesterAgent: Record<string, JsonValue>;
  subject: Record<string, JsonValue>;
  subjectHash: string;
  sourceObservations: SourceObservation[];
  sourceObservationSetHash: string;
  demosAnchorRefs: Array<{
    kind: string;
    network: string;
    txHash: string;
    contentHash: string;
    note?: string;
  }>;
  overallResult: {
    status: string;
    checkedSources: string[];
    notCheckedSources: string[];
    limitations: string[];
  };
  freshness: {
    validFrom: string;
    validUntil: string;
  };
  attestingAgent: {
    id: string;
    keyAlg: "Ed25519";
    publicKeyPem: string;
  };
  issuedAt: string;
  receiptHash: string;
  agentSignature: string;
};

export type CounterpartyEvidenceCheck = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
};

export type CounterpartyEvidenceVerification = {
  ok: boolean;
  current: boolean;
  expiresAt: string;
  checks: CounterpartyEvidenceCheck[];
};

const TRUSTED_ATTESTER_KEYS: Record<string, string> = {
  "did:demos:agent:counterparty-evidence-demo":
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAYzey4uB3DXleXtGk39UqyVvijWnHKxWFtNNwyyKqf7g=\n-----END PUBLIC KEY-----\n",
};

export const COUNTERPARTY_EVIDENCE_SERVICE_ID = "counterparty-evidence-receipt";
export const COUNTERPARTY_EVIDENCE_AGENT_ID = "did:demos:agent:6337b2e2e0770d795e5ed1a4dfd52ac95be28d69c72b1585b4d370cb22aa7fb8";
export const COUNTERPARTY_EVIDENCE_LISTING_VERSION = 1;
export const COUNTERPARTY_EVIDENCE_ANCHOR_LOCATOR = "fixture:counterparty-evidence-receipt";
export const counterpartyEvidenceFixture = fixtureReceipt as unknown as CounterpartyEvidenceReceipt;

export function isCounterpartyEvidenceDemoListing(
  sellerClaim: string,
  listing: { listingId: string; version: number; contentHash: string },
): boolean {
  return sellerClaim === COUNTERPARTY_EVIDENCE_AGENT_ID &&
    listing.listingId === COUNTERPARTY_EVIDENCE_SERVICE_ID &&
    listing.version === COUNTERPARTY_EVIDENCE_LISTING_VERSION &&
    listing.contentHash === COUNTERPARTY_EVIDENCE_LISTING_CONTENT_HASH;
}

function canonicalize(value: JsonValue): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error("canonical JSON values must not contain non-finite numbers");
  }
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(",")}}`;
}

function sha256Hex(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalize(value)).digest("hex")}`;
}

function sha256Digest(value: JsonValue): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export const COUNTERPARTY_EVIDENCE_LISTING_CONTRACT = {
  schema: "dacs-community.fixture-listing.v0",
  fixture: true,
  listingId: COUNTERPARTY_EVIDENCE_SERVICE_ID,
  listingVersion: COUNTERPARTY_EVIDENCE_LISTING_VERSION,
  agentId: COUNTERPARTY_EVIDENCE_AGENT_ID,
  serviceId: COUNTERPARTY_EVIDENCE_SERVICE_ID,
  name: "Counterparty evidence receipt",
  description: "Fixture-backed evidence receipt for a public counterparty observation.",
  category: "services.counterparty-evidence",
  tags: ["counterparty", "evidence", "receipt", "no-spend"],
  supportedNegotiation: ["negotiate-fixed-price"],
  supportedPaymentRails: ["pay-x402"],
  supportedDelivery: ["deliver-attested-payload"],
  limitations: [
    "fixture contract only; not chain anchored",
    "proves receipt integrity and authorship only",
    "does not prove source truth, certification, sanctions clearance, payment readiness, or settlement",
  ],
} satisfies Record<string, JsonValue>;

export const COUNTERPARTY_EVIDENCE_LISTING_CONTENT_HASH = sha256Digest(COUNTERPARTY_EVIDENCE_LISTING_CONTRACT);

export function readCounterpartyEvidenceFixtureAnchor(locator: string): Record<string, unknown> | null {
  return locator === COUNTERPARTY_EVIDENCE_ANCHOR_LOCATOR ? COUNTERPARTY_EVIDENCE_LISTING_CONTRACT : null;
}

export function verifyCounterpartyEvidenceFixtureListing(
  raw: Record<string, unknown>,
  listing: { listingId: string; version: number; contentHash: string },
): boolean {
  return raw === COUNTERPARTY_EVIDENCE_LISTING_CONTRACT &&
    listing.listingId === COUNTERPARTY_EVIDENCE_SERVICE_ID &&
    listing.version === COUNTERPARTY_EVIDENCE_LISTING_VERSION &&
    listing.contentHash === COUNTERPARTY_EVIDENCE_LISTING_CONTENT_HASH;
}

export function counterpartyEvidenceSellerRecord(now = Date.now()): SellerRecord {
  return {
    primaryClaim: COUNTERPARTY_EVIDENCE_AGENT_ID,
    discovered: false,
    ownerRegistered: false,
    displayName: "Counterparty Evidence Desk",
    identityTier: "self-declared",
    cci: [],
    listings: [{
      listingId: COUNTERPARTY_EVIDENCE_SERVICE_ID,
      version: COUNTERPARTY_EVIDENCE_LISTING_VERSION,
      contentHash: COUNTERPARTY_EVIDENCE_LISTING_CONTENT_HASH,
      anchor: { kind: "fixture", locator: COUNTERPARTY_EVIDENCE_ANCHOR_LOCATOR },
      artifactProfile: "fixture-listing",
      seller: {
        primaryClaim: COUNTERPARTY_EVIDENCE_AGENT_ID,
        displayName: "Counterparty Evidence Desk",
      },
      offering: {
        title: "Counterparty evidence receipt",
        description: "Fixture-backed evidence receipt for a public counterparty observation. It proves receipt integrity and authorship only, not source truth, compliance clearance, or payment readiness.",
        category: "services.counterparty-evidence",
        tags: ["counterparty", "evidence", "receipt", "no-spend"],
        rails: ["pay-x402"],
        delivery: ["deliver-attested-payload"],
        negotiation: ["negotiate-fixed-price"],
      },
      pricing: {},
      status: "active",
      catalogObservedAt: now,
    }],
    deals: [],
    reputation: {
      completed: 0,
      totalAgreements: 0,
      completionRate: null,
    },
    registeredAt: now,
    lastIndexedAt: now,
  };
}

export function upsertCounterpartyEvidenceSeller(sellers: SellerRecord[], now = Date.now()): SellerRecord[] {
  const fixtureSeller = counterpartyEvidenceSellerRecord(now);
  return [
    ...sellers.filter((seller) => seller.primaryClaim !== fixtureSeller.primaryClaim),
    fixtureSeller,
  ];
}

function unsignedReceipt(receipt: CounterpartyEvidenceReceipt): JsonValue {
  const { receiptHash: _receiptHash, agentSignature: _agentSignature, ...unsigned } = receipt;
  return unsigned as JsonValue;
}

function observationBody(observation: SourceObservation): JsonValue {
  const { observationHash: _observationHash, ...body } = observation;
  return body as JsonValue;
}

function isoDate(value: string, label: string): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new Error(`${label} must use RFC3339 millisecond UTC form`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label} is not a valid ISO timestamp`);
  return date;
}

function requireLimit(receipt: CounterpartyEvidenceReceipt, pattern: RegExp, label: string): void {
  const haystack = [receipt.claim, ...receipt.overallResult.limitations].join("\n");
  if (!pattern.test(haystack)) throw new Error(`missing explicit limit: ${label}`);
}

function assertSetEquals(actual: Set<string>, expected: Set<string>, label: string): void {
  const extra = [...actual].filter((value) => !expected.has(value));
  const missing = [...expected].filter((value) => !actual.has(value));
  if (extra.length > 0 || missing.length > 0) throw new Error(`${label} does not match source observations`);
}

function assertDisjoint(left: Set<string>, right: Set<string>, leftLabel: string, rightLabel: string): void {
  const overlap = [...left].filter((value) => right.has(value));
  if (overlap.length > 0) throw new Error(`${leftLabel} overlaps ${rightLabel}: ${overlap.join(", ")}`);
}

export function verifyCounterpartyEvidenceReceipt(receipt: CounterpartyEvidenceReceipt): CounterpartyEvidenceVerification {
  const checks: CounterpartyEvidenceCheck[] = [];
  const check = (id: string, label: string, fn: () => string) => {
    try {
      checks.push({ id, label, ok: true, detail: fn() });
    } catch (error) {
      checks.push({ id, label, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  };

  check("schema", "Receipt schema is the expected prototype shape", () => {
    if (receipt.schema !== "dacs-community.counterparty-evidence-receipt.v0") throw new Error("unsupported schema");
    if (receipt.conformanceStatus !== "prototype") throw new Error("fixture must declare prototype status");
    return receipt.schema;
  });

  check("subject", "Subject hash binds the named counterparty", () => {
    if (receipt.subjectHash !== sha256Hex(receipt.subject as JsonValue)) throw new Error("subjectHash mismatch");
    return receipt.subjectHash;
  });

  check("sources", "Every source observation hash matches its body", () => {
    if (receipt.sourceObservations.length === 0) throw new Error("no source observations");
    for (const observation of receipt.sourceObservations) {
      if (observation.observationHash !== sha256Hex(observationBody(observation))) {
        throw new Error(`observationHash mismatch: ${observation.sourceId}`);
      }
    }
    return `${receipt.sourceObservations.length} source observations`;
  });

  check("freshness", "Observation timestamps fit the receipt freshness window", () => {
    const validFrom = isoDate(receipt.freshness.validFrom, "freshness.validFrom");
    const validUntil = isoDate(receipt.freshness.validUntil, "freshness.validUntil");
    const issuedAt = isoDate(receipt.issuedAt, "issuedAt");
    if (validFrom > validUntil) throw new Error("freshness window is inverted");
    let maxObservedAt = validFrom;
    for (const observation of receipt.sourceObservations) {
      const observedAt = isoDate(observation.observedAt, `${observation.sourceId}.observedAt`);
      if (observedAt < validFrom || observedAt > validUntil) throw new Error(`${observation.sourceId} outside freshness window`);
      if (observedAt > maxObservedAt) maxObservedAt = observedAt;
    }
    if (issuedAt < maxObservedAt || issuedAt > validUntil) throw new Error("issuedAt outside valid observation window");
    return `${receipt.freshness.validFrom} to ${receipt.freshness.validUntil}`;
  });

  check("observation-set", "Observation-set hash binds all observations", () => {
    const hash = sha256Hex(receipt.sourceObservations as unknown as JsonValue);
    if (receipt.sourceObservationSetHash !== hash) throw new Error("sourceObservationSetHash mismatch");
    return hash;
  });

  check("anchor", "Fixture Demos anchor reference binds the observation set", () => {
    if (receipt.demosAnchorRefs.length === 0) throw new Error("missing anchor reference");
    for (const anchorRef of receipt.demosAnchorRefs) {
      if (anchorRef.contentHash !== receipt.sourceObservationSetHash) throw new Error("anchor contentHash mismatch");
    }
    return `${receipt.demosAnchorRefs.length} fixture anchor reference`;
  });

  check("source-status", "Checked/not-checked source lists match observations", () => {
    const declaredChecked = new Set(receipt.overallResult.checkedSources);
    const declaredNotChecked = new Set(receipt.overallResult.notCheckedSources);
    const derivedChecked = new Set<string>();
    const derivedNotChecked = new Set<string>();
    for (const observation of receipt.sourceObservations) {
      const status = String(observation.result.status ?? "");
      if (status === "not_checked") derivedNotChecked.add(observation.sourceId);
      else derivedChecked.add(observation.sourceId);
    }
    assertSetEquals(declaredChecked, derivedChecked, "checkedSources");
    assertSetEquals(declaredNotChecked, derivedNotChecked, "notCheckedSources");
    assertDisjoint(declaredChecked, declaredNotChecked, "checkedSources", "notCheckedSources");
    return `${declaredChecked.size} checked, ${declaredNotChecked.size} not checked`;
  });

  check("limits", "Receipt states what it does not prove", () => {
    requireLimit(receipt, /source truth/i, "no source-truth claim");
    requireLimit(receipt, /certification/i, "no certification claim");
    requireLimit(receipt, /sanctions clearance/i, "no sanctions-clearance claim");
    requireLimit(receipt, /payment|settlement/i, "no payment or settlement claim");
    return "source truth, certification, sanctions clearance, and payment limits present";
  });

  check("receipt-hash", "Receipt hash binds the unsigned receipt body", () => {
    const hash = sha256Hex(unsignedReceipt(receipt));
    if (receipt.receiptHash !== hash) throw new Error("receiptHash mismatch");
    return hash;
  });

  check("signature", "Attesting agent signature verifies against the pinned key", () => {
    if (receipt.attestingAgent.keyAlg !== "Ed25519") throw new Error("unsupported key algorithm");
    const trustedPublicKey = TRUSTED_ATTESTER_KEYS[receipt.attestingAgent.id];
    if (!trustedPublicKey) throw new Error("attesting agent is not trusted by this fixture verifier");
    if (receipt.attestingAgent.publicKeyPem !== trustedPublicKey) throw new Error("attesting public key mismatch");
    const publicKey = createPublicKey(trustedPublicKey);
    const signature = Buffer.from(receipt.agentSignature, "base64url");
    const ok = verifySignature(null, Buffer.from(receipt.receiptHash), publicKey, signature);
    if (!ok) throw new Error("signature mismatch");
    return receipt.attestingAgent.id;
  });

  const expiresAt = receipt.freshness.validUntil;
  const expiry = new Date(expiresAt);
  const current = !Number.isNaN(expiry.getTime()) && Date.now() <= expiry.getTime();
  return { ok: checks.every((item) => item.ok), current, expiresAt, checks };
}

export function buildCounterpartyEvidenceRun() {
  const verification = verifyCounterpartyEvidenceReceipt(counterpartyEvidenceFixture);
  return {
    serviceId: COUNTERPARTY_EVIDENCE_SERVICE_ID,
    mode: "fixture",
    input: {
      subjectName: "Microsoft Corporation",
      lei: "INR2EJN1ERAN0W5ZP974",
      sources: ["gleif-lei-record", "ofac-sdn-csv-exact-name", "sam-gov-exclusions"],
    },
    receipt: counterpartyEvidenceFixture,
    verification,
  };
}
