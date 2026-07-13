import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";

import { POST } from "../app/api/dacs/counterparty-evidence/run/route.js";
import {
  COUNTERPARTY_EVIDENCE_LISTING_CONTRACT,
  COUNTERPARTY_EVIDENCE_AGENT_ID,
  COUNTERPARTY_EVIDENCE_LISTING_CONTENT_HASH,
  COUNTERPARTY_EVIDENCE_LISTING_VERSION,
  COUNTERPARTY_EVIDENCE_SERVICE_ID,
  counterpartyEvidenceSellerRecord,
  counterpartyEvidenceFixture,
  isCounterpartyEvidenceDemoListing,
  type CounterpartyEvidenceReceipt,
  verifyCounterpartyEvidenceReceipt,
} from "../src/catalog/counterpartyEvidence.js";
import { readAnchor } from "../src/catalog/chain.js";

function cloneReceipt(): CounterpartyEvidenceReceipt {
  return structuredClone(counterpartyEvidenceFixture);
}

test("counterparty evidence fixture verifies", () => {
  const result = verifyCounterpartyEvidenceReceipt(cloneReceipt());
  assert.equal(result.ok, true);
  assert.equal(result.current, false);
  assert.ok(result.checks.length >= 8);
});

test("counterparty evidence verifier rejects changed subject binding", () => {
  const receipt = cloneReceipt();
  receipt.subject.name = "CONTOSO LTD";
  const result = verifyCounterpartyEvidenceReceipt(receipt);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.id === "subject" && !check.ok));
});

test("counterparty evidence verifier rejects changed source observation", () => {
  const receipt = cloneReceipt();
  receipt.sourceObservations[0]!.result.observedLegalName = "TAMPERED";
  const result = verifyCounterpartyEvidenceReceipt(receipt);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.id === "sources" && !check.ok));
});

test("counterparty evidence verifier rejects signer mismatch", () => {
  const receipt = cloneReceipt();
  receipt.attestingAgent.id = "did:demos:agent:other";
  const result = verifyCounterpartyEvidenceReceipt(receipt);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.id === "signature" && !check.ok));
});

test("counterparty evidence verifier rejects stale source observation", () => {
  const receipt = cloneReceipt();
  receipt.sourceObservations[0]!.observedAt = "2026-07-08T12:40:00.000Z";
  const result = verifyCounterpartyEvidenceReceipt(receipt);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.id === "freshness" && !check.ok));
});

test("counterparty evidence verifier rejects missing anchor reference", () => {
  const receipt = cloneReceipt();
  receipt.demosAnchorRefs = [];
  const result = verifyCounterpartyEvidenceReceipt(receipt);
  assert.equal(result.ok, false);
  assert.ok(result.checks.some((check) => check.id === "anchor" && !check.ok));
});

test("counterparty evidence run API returns receipt plus verification report", async () => {
  const response = await POST();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.serviceId, "counterparty-evidence-receipt");
  assert.equal(body.mode, "fixture");
  assert.equal(body.receipt.jobId, counterpartyEvidenceFixture.jobId);
  assert.equal(body.verification.ok, true);
  assert.equal(body.verification.current, false);
  assert.equal(body.verification.expiresAt, counterpartyEvidenceFixture.freshness.validUntil);
});

test("counterparty evidence runner is scoped to the fixture seller and listing", () => {
  const listing = {
    listingId: COUNTERPARTY_EVIDENCE_SERVICE_ID,
    version: COUNTERPARTY_EVIDENCE_LISTING_VERSION,
    contentHash: COUNTERPARTY_EVIDENCE_LISTING_CONTENT_HASH,
  };
  assert.equal(isCounterpartyEvidenceDemoListing(COUNTERPARTY_EVIDENCE_AGENT_ID, listing), true);
  assert.equal(isCounterpartyEvidenceDemoListing("did:demos:agent:other", listing), false);
  assert.equal(isCounterpartyEvidenceDemoListing(COUNTERPARTY_EVIDENCE_AGENT_ID, { ...listing, contentHash: "other" }), false);
});

test("counterparty fixture seed record exposes the runnable service", () => {
  const seller = counterpartyEvidenceSellerRecord(1783760400000);
  assert.equal(seller.primaryClaim, COUNTERPARTY_EVIDENCE_AGENT_ID);
  assert.equal(seller.listings.length, 1);
  assert.equal(seller.listings[0]!.anchor.kind, "fixture");
  assert.equal(isCounterpartyEvidenceDemoListing(seller.primaryClaim, seller.listings[0]!), true);
});

test("counterparty fixture seed command persists the reindex marker", () => {
  const dataDir = mkdtempSync(`${tmpdir()}/dacs-counterparty-fixture-`);
  const appDir = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  try {
    execFileSync(process.execPath, ["--import", "tsx", "scripts/seed-counterparty-fixture.ts"], {
      cwd: appDir,
      env: { ...process.env, DACS_DIRECTORY_DATA: dataDir },
      stdio: "pipe",
    });
    const seeds = JSON.parse(readFileSync(`${dataDir}/fixtures.json`, "utf8")) as unknown;
    const catalog = JSON.parse(readFileSync(`${dataDir}/catalog.json`, "utf8")) as { sellers?: Array<{ primaryClaim?: string }> };
    assert.deepEqual(seeds, ["counterparty-evidence"]);
    assert.ok(catalog.sellers?.some((seller) => seller.primaryClaim === COUNTERPARTY_EVIDENCE_AGENT_ID));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("counterparty fixture listing JSON path serves the machine contract", async () => {
  const priorDataDir = process.env.DACS_DIRECTORY_DATA;
  const dataDir = mkdtempSync(`${tmpdir()}/dacs-counterparty-directory-`);
  copyFileSync(fileURLToPath(new URL("./fixtures/counterparty-directory/catalog.json", import.meta.url)), `${dataDir}/catalog.json`);
  process.env.DACS_DIRECTORY_DATA = dataDir;
  try {
    const { GET: getListingContract } = await import("../app/api/dacs/listings/[listingId]/[version]/route.js");
    const response = await getListingContract(
      new NextRequest(`http://localhost/api/dacs/listings/${COUNTERPARTY_EVIDENCE_SERVICE_ID}/1?seller=${encodeURIComponent(COUNTERPARTY_EVIDENCE_AGENT_ID)}`),
      { params: Promise.resolve({ listingId: COUNTERPARTY_EVIDENCE_SERVICE_ID, version: "1" }) },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body, COUNTERPARTY_EVIDENCE_LISTING_CONTRACT);
  } finally {
    if (priorDataDir === undefined) delete process.env.DACS_DIRECTORY_DATA;
    else process.env.DACS_DIRECTORY_DATA = priorDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("counterparty fixture is not exposed through generic chain reads", async () => {
  const value = await readAnchor("fixture:counterparty-evidence-receipt");
  assert.equal(value, null);
});
