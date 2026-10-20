import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-persistent-rules-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const claim = `did:demos:agent:${"1".repeat(64)}`;
const native = `stor-${"a".repeat(40)}`;
const seller = (primaryClaim: string) => ({ primaryClaim, displayName: primaryClaim, cci: [], listings: [], deals: [], reputation: {}, registeredAt: 1, lastIndexedAt: 1 });
const registration = { primaryClaim: claim, displayName: "preserved", listingAnchors: [native], deals: [], registeredAt: 1 };
const state = { schemaVersion: 9, lastSeenTxId: 42, listings: { [native]: claim }, deals: {}, programs: { [`0x${"1".repeat(64)}\ndacs3:agreement:job`]: native }, revocations: {}, verifiedRevocations: {} };
const legacy = { catalog: { catalogVersion: "1", generatedAt: 100, sellers: [seller(claim)] }, registrations: [registration], "scan-state": state, domains: ["https://example.com"], fixtures: ["counterparty-evidence"] };
for (const [name, value] of Object.entries(legacy)) writeFileSync(join(dataDirectory, `${name}.json`), JSON.stringify(value));
const store = await import("../src/catalog/store.js");
const storeUrl = new URL("../src/catalog/store.js", import.meta.url).href;
const db = new Database(join(dataDirectory, "directory.sqlite"));
test.after(() => { db.close(); rmSync(dataDirectory, { recursive: true, force: true }); });

function snapshot() {
  return { registrations: store.loadRegistrations(), scan: store.loadScanState(), catalog: store.loadCatalog(), domains: store.loadDomains(), fixtures: store.loadFixtureSeeds() };
}

test("nonempty JSON migration preserves each state key and remains idempotent across two process restarts", () => {
  const initial = snapshot();
  assert.deepEqual(initial.registrations, [registration]);
  assert.deepEqual({ ...initial.scan.listings }, state.listings);
  assert.deepEqual({ ...initial.scan.programs }, state.programs);
  assert.equal(initial.scan.lastSeenTxId, 42);
  assert.deepEqual(initial.domains, legacy.domains);
  assert.deepEqual(initial.fixtures, legacy.fixtures);
  assert.deepEqual(initial.catalog.sellers.map((seller) => seller.primaryClaim), [claim]);
  assert.equal(store.resolveProgramAddress(`0x${"1".repeat(64)}`, "dacs3:agreement:job"), native);
  assert.equal(store.findProgramAddress(claim, "dacs3:agreement:job"), native);
  assert.equal(store.findProgramAddress(claim, "unobserved"), null);
  // Rollback snapshots change after migration: they must never overwrite the database.
  for (const name of Object.keys(legacy)) writeFileSync(join(dataDirectory, `${name}.json`), JSON.stringify(name === "catalog" ? { sellers: [] } : []));
  const code = `const s = await import(${JSON.stringify(storeUrl)}); console.log(JSON.stringify({ registrations:s.loadRegistrations(),scan:s.loadScanState(),catalog:s.loadCatalog(),domains:s.loadDomains(),fixtures:s.loadFixtureSeeds() }));`;
  for (let restart = 0; restart < 2; restart++) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { encoding: "utf8", env: process.env });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(initial)));
  }
});

test("infrastructure faults propagate without replacing the previously published catalog", () => {
  const before = store.loadCatalog();
  for (const code of ["EIO", "ENOSPC", "EROFS", "EACCES", "SQLITE_FULL", "SQLITE_IOERR", "SQLITE_BUSY"]) {
    const error = Object.assign(new Error("injected storage fault"), { code });
    assert.throws(() => store.throwIfInfrastructureError(error), (actual) => actual === error);
    assert.deepEqual(store.loadCatalog(), before);
  }
  for (const error of [null, {}, new Error("artifact rejected"), { code: "NOT_FOUND" }])
    assert.doesNotThrow(() => store.throwIfInfrastructureError(error));
});

test("publication leases execute and renew the callback, recover expiry, and release their own token on error", async () => {
  const originalNow = Date.now;
  const originalInterval = globalThis.setInterval;
  let clock = 1000;
  let renew: (() => void) | undefined;
  Date.now = () => clock;
  globalThis.setInterval = ((callback: () => void, interval: number) => {
    assert.equal(interval, 30000);
    renew = callback;
    return originalInterval(() => {}, 30000);
  }) as typeof setInterval;
  try {
    db.prepare("INSERT INTO leases(name,token,expires_at) VALUES ('lease-rule','expired',999)").run();
    let calls = 0;
    const answer = await store.withDataLock("lease-rule", () => {
      calls++;
      const row = db.prepare("SELECT * FROM leases WHERE name='lease-rule'").get() as { token: string; expires_at: number };
      assert.notEqual(row.token, "expired");
      assert.equal(row.expires_at, 121000);
      clock = 31000;
      assert.ok(renew); renew();
      assert.deepEqual(db.prepare("SELECT token,expires_at FROM leases WHERE name='lease-rule'").get(), { token: row.token, expires_at: 151000 });
      return "callback-result";
    });
    assert.equal(answer, "callback-result"); assert.equal(calls, 1);
    assert.equal(db.prepare("SELECT * FROM leases WHERE name='lease-rule'").get(), undefined);
    const fault = new Error("callback failed");
    await assert.rejects(store.withDataLock("lease-rule", () => { throw fault; }), (actual) => actual === fault);
    assert.equal(db.prepare("SELECT * FROM leases WHERE name='lease-rule'").get(), undefined);
    // A replaced token belongs to a successor and must not be deleted by this holder.
    await store.withDataLock("lease-rule", () => { db.prepare("UPDATE leases SET token='successor' WHERE name='lease-rule'").run(); });
    assert.equal((db.prepare("SELECT token FROM leases WHERE name='lease-rule'").get() as {token:string}).token, "successor");
    db.prepare("DELETE FROM leases WHERE name='lease-rule'").run();
  } finally { Date.now = originalNow; globalThis.setInterval = originalInterval; }
});

test("two processes serialize independent seller updates and preserve both publications", { timeout: 10000 }, async () => {
  let unlock!: () => void;
  const gate = new Promise<void>((resolve) => { unlock = resolve; });
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => { entered = resolve; });
  const parent = store.withDataLock("publication-rule", async () => {
    const catalog = store.loadCatalog(); entered(); await gate;
    store.saveCatalog({ ...catalog, sellers: [...catalog.sellers, seller("parent") as never] });
  });
  await holding;
  const code = `const s=await import(${JSON.stringify(storeUrl)}); console.log('ready'); await s.withDataLock('publication-rule',()=>{ console.log('entered'); const c=s.loadCatalog(); s.saveCatalog({...c,sellers:[...c.sellers,${JSON.stringify(seller("child"))}]}); });`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stderr.on("data", (data) => { stderr += String(data); });
  const finished = new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
  try {
    await new Promise<void>((resolve) => { child.stdout.on("data", (data) => { stdout += String(data); if (stdout.includes("ready")) resolve(); }); });
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(stdout.includes("entered"), false, "the child cannot enter while the parent holds the lease");
    unlock(); await parent;
    assert.equal(await finished, 0, stderr);
    assert.equal(stdout.includes("entered"), true);
    assert.deepEqual(store.loadCatalog().sellers.map((item) => item.primaryClaim).sort(), [claim, "parent", "child"].sort());
  } finally { unlock(); child.kill(); await parent; }
});


test("a fresh database preserves its declared empty catalog and queue defaults", () => {
  const emptyDirectory = mkdtempSync(join(dataDirectory, "fresh-"));
  const code = `const s=await import(${JSON.stringify(storeUrl)}); console.log(JSON.stringify({catalog:s.loadCatalog(),registrations:s.loadRegistrations(),domains:s.loadDomains(),fixtures:s.loadFixtureSeeds(),scan:s.loadScanState()}));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    encoding: "utf8", env: { ...process.env, DACS_DIRECTORY_DATA: emptyDirectory },
  });
  assert.equal(child.status, 0, child.stderr);
  const state = JSON.parse(child.stdout);
  assert.deepEqual(state.catalog, { catalogVersion: "1", generatedAt: 0, sellers: [] });
  assert.deepEqual(state.registrations, []); assert.deepEqual(state.domains, []); assert.deepEqual(state.fixtures, []);
  assert.equal(state.scan.lastSeenTxId, 0); assert.deepEqual(state.scan.listings, {}); assert.deepEqual(state.scan.deals, {});
});

test("a live publication lease is neither stolen nor waited on again once the acquisition deadline is reached", async () => {
  const originalNow = Date.now; const originalTimeout = globalThis.setTimeout;
  let reads = 0; let waits = 0; let entered = false;
  Date.now = () => ++reads === 1 ? 1000 : reads <= 3 ? 11000 : 11001;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, milliseconds?: number, ...args: any[]) => {
    if (milliseconds === 25) waits++;
    return originalTimeout(callback, milliseconds, ...args);
  }) as typeof setTimeout;
  db.prepare("INSERT INTO leases(name,token,expires_at) VALUES ('deadline-rule','live',999999)").run();
  try {
    await assert.rejects(store.withDataLock("deadline-rule", () => { entered = true; }), /timed out waiting for deadline-rule data lease/);
    assert.equal(entered, false);
    assert.equal(waits, 0, "no further acquisition wait is allowed at the inclusive deadline");
    assert.deepEqual(db.prepare("SELECT token,expires_at FROM leases WHERE name='deadline-rule'").get(), { token: "live", expires_at: 999999 });
  } finally {
    Date.now = originalNow; globalThis.setTimeout = originalTimeout;
    db.prepare("DELETE FROM leases WHERE name='deadline-rule'").run();
  }
});
