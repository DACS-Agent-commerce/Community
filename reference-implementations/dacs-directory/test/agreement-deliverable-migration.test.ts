import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Verdicts saved before the Agreement deliverable rule were never checked against it, so the startup step
// clears derived deal credit once and keeps Listings.
const KEY = "agreement-deliverable-schema-version";
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-deliverable-migration-"));
const seller = `did:demos:agent:${"8".repeat(64)}`;
const buyer = `did:demos:agent:${"6".repeat(64)}`;
const seeded = new Database(join(dataDirectory, "directory.sqlite"));
seeded.exec(`
  CREATE TABLE kv_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO kv_state(key,value_json,updated_at) VALUES ('schema-version','1',0), ('listing-admission-schema-version','2',0), ('commitment-finality-schema-version','3',0);
`);
seeded.prepare("INSERT INTO kv_state(key,value_json,updated_at) VALUES ('catalog',?,0)").run(JSON.stringify({
  catalogVersion: "1",
  generatedAt: 1_000,
  sellers: [{
    primaryClaim: seller,
    displayName: "migration seller",
    cci: [],
    listings: [{
      listingId: "listing-1",
      version: 1,
      contentHash: "ab".repeat(32),
      anchor: { kind: "storage-program", locator: `stor-${"9".repeat(40)}` },
      seller: { primaryClaim: seller, displayName: "migration seller" },
      offering: { title: "test", category: "test", tags: [] },
      pricing: {},
      status: "active",
      catalogObservedAt: 1,
    }],
    deals: [{
      jobId: "job-1",
      rail: "pay-dem",
      buyerBundleRef: `stor-${"7".repeat(40)}`,
      owners: { buyer, seller },
      signatureVerified: true,
      refsVerified: true,
      sellerOutcome: "completed",
      finalisedAt: 100,
      verifiedAt: 200,
      reputationEligible: true,
      ratings: [],
    }],
    reputation: { completed: 1, bundleCount: 1, totalAgreements: 1, completionRate: 1 },
    registeredAt: 1,
    lastIndexedAt: 1,
  }],
}));
seeded.close();

const restart = () => {
  const moduleUrl = new URL("../src/catalog/store.js", import.meta.url).href;
  const code = `const s=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(s.loadStoredCatalog()));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code],
    { encoding: "utf8", cwd: new URL("..", import.meta.url), env: { ...process.env, DACS_DIRECTORY_DATA: dataDirectory }, timeout: 30_000 });
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout) as { sellers: Array<{ deals: Array<Record<string, unknown>>; listings: Array<Record<string, unknown>>;
    reputation: Record<string, unknown> }> };
};
const stored = (key: string) => {
  const db = new Database(join(dataDirectory, "directory.sqlite"), { readonly: true });
  try { return (db.prepare("SELECT value_json FROM kv_state WHERE key=?").get(key) as { value_json: string } | undefined)?.value_json; }
  finally { db.close(); }
};

test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

test("startup clears deal credit saved before the deliverable rule, recomputes reputation and keeps Listings", () => {
  assert.equal(stored(KEY), undefined);
  const catalog = restart();
  const [record] = catalog.sellers;
  assert.equal(record.deals[0].refsVerified, false);
  assert.equal(record.deals[0].reputationEligible, false);
  assert.equal(record.reputation.completed, 0);
  assert.equal(record.listings.length, 1);
  assert.equal(record.listings[0].status, "active");
  assert.equal(stored(KEY), "1");
});

test("the step runs once: credit earned afterwards survives another restart", () => {
  const db = new Database(join(dataDirectory, "directory.sqlite"));
  const row = db.prepare("SELECT value_json FROM kv_state WHERE key='catalog'").get() as { value_json: string };
  const catalog = JSON.parse(row.value_json);
  catalog.sellers[0].deals[0].refsVerified = true;
  catalog.sellers[0].deals[0].reputationEligible = true;
  db.prepare("UPDATE kv_state SET value_json=? WHERE key='catalog'").run(JSON.stringify(catalog));
  db.close();
  const deal = restart().sellers[0].deals[0];
  assert.equal(deal.refsVerified, true);
  assert.equal(deal.reputationEligible, true);
  assert.equal(stored(KEY), "1");
});
