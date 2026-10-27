import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the actual crawler without loading Listing verification or the SDK.
// Signature and binding verification have separate integration coverage; these
// stubs let the same row-validation cases run with and without source authority.
const dependencies = new Map([
  ["./listingVerification.js", "export const revocationLogicalAddress = () => 'test-revocation';"],
  ["./canonical.js", `import { createHash } from 'node:crypto';
    export const sha256Hex = raw => createHash('sha256').update(raw).digest('hex');`],
  ["./bundleBinding.js", "export const verifyBundleBinding = async () => null;"],
  ["./primaryClaimKey.js", "export const verifyPrimaryClaimSignature = async () => ({});"],
  ["@kynesyslabs/dacs/artifacts", "export const isRevocationBinding = value => value?.bindingVersion === '1';"],
  ["@kynesyslabs/dacs/identity", "export const sameCanonicalClaimIdentity = (left, right) => left === right;"],
]);
const bundled = await build({
  entryPoints: [fileURLToPath(new URL("../src/catalog/wellknown.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "crawler-dependencies", setup(builder) {
    builder.onResolve({ filter: /./ }, ({ path }) => dependencies.has(path)
      ? { path, namespace: "crawler-dependency" } : undefined);
    builder.onLoad({ filter: /./, namespace: "crawler-dependency" }, ({ path }) => ({ contents: dependencies.get(path) }));
  } }],
});
const { crawlDomain, crawlDomains } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const domain = "https://seller.example";
const seller = `did:demos:agent:${"a".repeat(64)}`;
const anchor = `stor-${"1".repeat(40)}`;
const firstHash = "ab".repeat(32);
const secondHash = "cd".repeat(32);
const row = (contentHash, extra = {}) => ({
  listingId: "service", version: 1, contentHash,
  anchor: { kind: "storage-program", locator: anchor }, status: "active",
  summary: { title: "Service", category: "services.test", tags: [] }, ...extra,
});
const revocation = {
  bindingVersion: "1", sellerPrimaryClaim: seller, listingId: "service", listingVersion: 1,
  listingContentHash: firstHash, logicalAddress: "test-revocation",
  markerAnchor: { kind: "storage-program", locator: `stor-${"2".repeat(40)}` },
  markerContentHash: "e".repeat(64),
};

function hosted(listings, signed = false, source = domain) {
  const raw = JSON.stringify({ indexVersion: "1", generatedAt: 1, seller, listings });
  const indexHash = createHash("sha256").update(raw).digest("hex");
  const card = JSON.stringify({ dacs: { dacsVersion: "1", listings: {
    indexUrl: `${source}/listings.json`, indexHash,
    ...(signed ? { publisherSignature: "A".repeat(86) } : {}),
  } } });
  return {
    validateUrl: async (url) => ({ url: new URL(url), ip: "203.0.113.1" }),
    fetchJson: async (url) => {
      const document = url.endsWith("agent.json") ? card : raw;
      return { raw: document, body: JSON.parse(document) };
    },
  };
}

const conflicts = [
  ["complete active rows", row(firstHash)],
  ["missing listing ID", row(firstHash, { listingId: undefined })],
  ["invalid version", row(firstHash, { version: 0 })],
  ["missing summary", row(firstHash, { summary: undefined })],
  ["unknown status", row(firstHash, { status: "unknown" })],
  ["unsupported anchor kind", row(firstHash, { anchor: { kind: "unknown", locator: anchor } })],
  ["uppercase hash", row(firstHash.toUpperCase())],
  ["complete revoked row", row(firstHash, { status: "revoked", revocation })],
];
for (const signed of [false, true]) {
  for (const [name, conflicting] of conflicts) {
    for (const reverse of [false, true]) {
      test(`rejects ${name} with conflicting anchor hashes (signed ${signed}, reversed ${reverse})`, async () => {
        const rows = [conflicting, row(secondHash)];
        const result = await crawlDomain(domain, hosted(reverse ? rows.toReversed() : rows, signed));
        assert.deepEqual(result, { domain, error: "listings.json has conflicting content hashes for the same anchor" });
      });
    }
  }
}

test("a later matching duplicate cannot erase an earlier hash conflict", async () => {
  const result = await crawlDomain(domain, hosted([row(firstHash), row(secondHash), row(firstHash)], true));
  assert.ok("error" in result);
});

test("equal duplicate rows retain one active anchor and one declaration", async () => {
  const result = await crawlDomain(domain, hosted([row(firstHash), row(firstHash)], true));
  assert.ok(!("error" in result));
  assert.equal(result.withdrawalAuthenticated, true);
  assert.deepEqual(result.listingAnchors, [anchor]);
  assert.deepEqual(result.activeListingAnchors, [anchor]);
  assert.deepEqual(result.contentHashes, { [anchor]: firstHash });
  assert.deepEqual(result.withdrawalHashes, [firstHash]);
});

test("equal normalized hashes do not conflict or promote an incomplete row", async () => {
  for (const rows of [[row(firstHash), row(firstHash.toUpperCase())], [row(firstHash.toUpperCase()), row(firstHash)]]) {
    const result = await crawlDomain(domain, hosted(rows, true));
    assert.ok(!("error" in result));
    assert.deepEqual(result.contentHashes, { [anchor]: firstHash });
    assert.deepEqual(result.activeListingAnchors, []);
    assert.deepEqual(result.incompleteWithdrawalHashes, [firstHash]);
  }
});

test("different anchors can declare the same or different hashes", async () => {
  const otherAnchor = `stor-${"3".repeat(40)}`;
  for (const hash of [firstHash, secondHash]) {
    const result = await crawlDomain(domain, hosted([
      row(firstHash), row(hash, { anchor: { kind: "storage-program", locator: otherAnchor } }),
    ]));
    assert.ok(!("error" in result));
    assert.deepEqual(result.contentHashes, { [anchor]: firstHash, [otherAnchor]: hash });
    assert.deepEqual(result.activeListingAnchors, [anchor, otherAnchor]);
  }
});

test("a conflicting domain is isolated while a valid peer remains discoverable", async () => {
  const peer = "https://peer.example";
  const bad = hosted([row(firstHash), row(secondHash)], true);
  const good = hosted([row(firstHash)], true, peer);
  const result = await crawlDomains([domain, peer], {
    validateUrl: good.validateUrl,
    fetchJson: (url) => (new URL(url).origin === domain ? bad : good).fetchJson(url),
  });
  assert.deepEqual(result.agents.map(agent => agent.domain), [peer]);
  assert.deepEqual(result.errors, [{ domain, error: "listings.json has conflicting content hashes for the same anchor" }]);
});
