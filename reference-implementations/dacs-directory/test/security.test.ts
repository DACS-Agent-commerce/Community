import assert from "node:assert/strict";
import test from "node:test";

import { parsePagination } from "../src/catalog/pagination.js";
import { parseRegistration } from "../src/catalog/registration.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import {
  crawlDomain,
  isPrivateAddress,
  normalizeSubmittedDomain,
} from "../src/catalog/wellknown.js";

const claim = `did:demos:agent:${"a".repeat(64)}`;

test("registration parser rejects type-confusion and oversized collections", () => {
  assert.equal(parseRegistration({ primaryClaim: {}, displayName: "x", listingAnchors: [] }).ok, false);
  assert.equal(parseRegistration({ primaryClaim: claim, displayName: "x", listingAnchors: [], deals: {} }).ok, false);
  assert.equal(parseRegistration({
    primaryClaim: claim,
    displayName: "x",
    listingAnchors: Array.from({ length: 33 }, (_, i) => `stor-${i.toString(16).padStart(40, "0")}`),
  }).ok, false);
});

test("registration parser accepts and normalizes a bounded registration", () => {
  const result = parseRegistration({
    primaryClaim: claim,
    displayName: " Agent ",
    listingAnchors: [`stor-${"b".repeat(40)}`, `stor-${"b".repeat(40)}`],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.displayName, "Agent");
    assert.equal(result.value.listingAnchors.length, 1);
  }
});

test("registration owner message binds offered reputation deals", () => {
  const base = { primaryClaim: claim, displayName: "Agent", listingAnchors: [] };
  const withoutDeal = registrationMessage(base, 1);
  const withDeal = registrationMessage({
    ...base,
    deals: [{
      jobId: "j",
      rail: "pay-dem",
      buyerBundleRef: `stor-${"b".repeat(40)}`,
      owners: { buyer: claim, seller: claim },
    }],
  }, 1);
  assert.notEqual(withoutDeal, withDeal);
});

test("pagination rejects negative, fractional, and oversized inputs", () => {
  assert.equal(parsePagination("-1", "0").ok, false);
  assert.equal(parsePagination("201", "0").ok, false);
  assert.equal(parsePagination("1.5", "0").ok, false);
  assert.equal(parsePagination("50", "-1").ok, false);
  assert.deepEqual(parsePagination(null, null), { ok: true, limit: 50, cursor: 0 });
});

test("well-known URL policy rejects unsafe schemes and address ranges", async () => {
  assert.throws(() => normalizeSubmittedDomain("http://example.com"));
  assert.throws(() => normalizeSubmittedDomain("https://example.com/path"));
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  const result = await crawlDomain("https://127.0.0.1");
  assert.equal("error" in result, true);
});
