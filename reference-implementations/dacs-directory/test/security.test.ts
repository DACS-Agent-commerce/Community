import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";

import { listingPresentation } from "../src/catalog/listingMetadata.js";
import { parsePagination } from "../src/catalog/pagination.js";
import { parseRegistration } from "../src/catalog/registration.js";
import { registrationMessage } from "../src/catalog/registrationSig.js";
import {
  rateLimit,
  rateLimitClientKey,
  rateLimitStateSize,
  resetRateLimitState,
} from "../src/catalog/security.js";
import { programBindingKey } from "../src/catalog/store.js";
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

test("program bindings canonicalize Demos DIDs and substrate addresses", () => {
  const hex = "a".repeat(64);
  const name = "dacs3:agreement:job";
  assert.equal(
    programBindingKey(`did:demos:agent:${hex}`, name),
    programBindingKey(`0x${hex.toUpperCase()}`, name),
  );
});

test("extensible listing metadata is normalized before catalog persistence", () => {
  const hostile = listingPresentation({
    name: "x".repeat(250),
    description: "y".repeat(2100),
    category: { crash: true },
    tags: { crash: true },
    supportedPaymentRails: ["pay-dem", {}, "INVALID RAIL"],
    supportedDelivery: Array.from({ length: 20 }, (_, i) => `deliver-${i}`),
    supportedNegotiation: "not-an-array",
  });
  assert.equal(hostile.title.length, 200);
  assert.equal(hostile.description.length, 2000);
  assert.equal(hostile.category, "services.other");
  assert.deepEqual(hostile.tags, []);
  assert.deepEqual(hostile.rails, ["pay-dem"]);
  assert.equal(hostile.delivery.length, 16);
  assert.deepEqual(hostile.negotiation, []);
});

test("well-known URL policy rejects unsafe schemes and address ranges", async () => {
  assert.throws(() => normalizeSubmittedDomain("http://example.com"));
  assert.throws(() => normalizeSubmittedDomain("https://example.com/path"));
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("10.0.0.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  // IPv4-mapped forms must fall back to the v4 policy (rebinding hardening).
  assert.equal(isPrivateAddress("::ffff:169.254.169.254"), true);
  assert.equal(isPrivateAddress("::ffff:172.16.0.1"), true);
  assert.equal(isPrivateAddress("::ffff:100.64.0.1"), true);
  assert.equal(isPrivateAddress("::ffff:a9fe:a9fe"), true);
  assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateAddress("0:0:0:0:0:0:0:1"), true);
  assert.equal(isPrivateAddress("fec0::1"), true);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  const result = await crawlDomain("https://127.0.0.1");
  assert.equal("error" in result, true);
});

test("rate-limit state ignores spoofed proxy headers by default and stays bounded", () => {
  const prior = process.env.DACS_TRUST_PROXY;
  try {
    delete process.env.DACS_TRUST_PROXY;
    const spoofed = new NextRequest("https://directory.test/api", {
      headers: { "x-forwarded-for": "169.254.169.254" },
    });
    assert.equal(rateLimitClientKey(spoofed), null);
    assert.equal(rateLimit(spoofed, "untrusted", 1), null);
    assert.equal(rateLimitStateSize(), 0);

    process.env.DACS_TRUST_PROXY = "1";
    assert.equal(rateLimitClientKey(spoofed), "169.254.169.254");
    assert.equal(
      rateLimitClientKey(new NextRequest("https://directory.test/api", {
        headers: { "x-forwarded-for": "not-an-ip" },
      })),
      null,
    );

    resetRateLimitState();
    for (let i = 0; i < 4_200; i++) {
      const ip = `10.${Math.floor(i / 65_536)}.${Math.floor(i / 256) % 256}.${i % 256}`;
      rateLimit(new NextRequest("https://directory.test/api", {
        headers: { "x-forwarded-for": ip },
      }), "bounded-test", 1);
    }
    assert.ok(rateLimitStateSize() <= 4_096);
  } finally {
    resetRateLimitState();
    if (prior === undefined) delete process.env.DACS_TRUST_PROXY;
    else process.env.DACS_TRUST_PROXY = prior;
  }
});
