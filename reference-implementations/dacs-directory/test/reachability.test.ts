import assert from "node:assert/strict";
import test from "node:test";

import { isPrivateAddress } from "../src/catalog/boundedHttps.js";
import {
  effectiveReachabilityStatus,
  probeReachabilitySurface,
  REACHABILITY_FRESH_MS,
  refreshReachabilityHints,
} from "../src/catalog/reachability.js";
import type { ReachabilityHint, SellerRecord } from "../src/catalog/types.js";

const now = 2_000_000_000_000;
const seller = (suffix: string, hint?: ReachabilityHint): SellerRecord => ({
  primaryClaim: `did:demos:agent:${suffix.repeat(64)}`,
  displayName: `seller ${suffix}`,
  cci: [],
  listings: [{
    listingId: `listing-${suffix}`,
    version: 1,
    contentHash: suffix.repeat(64),
    anchor: { kind: "storage-program", locator: `stor-${suffix.repeat(40)}` },
    seller: { primaryClaim: `did:demos:agent:${suffix.repeat(64)}`, displayName: `seller ${suffix}` },
    publicEndpoint: `https://${suffix}.example/agent`,
    offering: { title: "service", category: "services.test", tags: [] },
    pricing: {},
    status: "active",
    catalogObservedAt: now,
    reachabilityHint: hint,
  }],
  deals: [],
  reputation: { completed: 0, totalAgreements: 0, completionRate: null },
  registeredAt: now,
  lastIndexedAt: now,
});

test("reachability rendering treats stale observations as unknown", () => {
  assert.equal(effectiveReachabilityStatus({ status: "reachable", checkedAt: now }, now), "reachable");
  assert.equal(effectiveReachabilityStatus({ status: "reachable", checkedAt: now - REACHABILITY_FRESH_MS - 1 }, now), "unknown");
});

test("refresh reuses fresh hints and does not affect listing validity or trust fields", async () => {
  const fresh = { status: "reachable", checkedAt: now - 1_000, surface: "https://a.example/agent" } as const;
  const current = [seller("a")];
  const prior = [seller("a", fresh)];
  const immutable = {
    status: current[0].listings[0].status,
    identityTier: current[0].identityTier,
    reputation: structuredClone(current[0].reputation),
  };
  let probes = 0;

  await refreshReachabilityHints(current, prior, {
    now,
    probe: async () => { probes += 1; throw new Error("must not probe"); },
  });

  assert.equal(probes, 0);
  assert.deepEqual(current[0].listings[0].reachabilityHint, fresh);
  assert.deepEqual({
    status: current[0].listings[0].status,
    identityTier: current[0].identityTier,
    reputation: current[0].reputation,
  }, immutable);
});

test("refresh is bounded, round-robin, and replaces stale claims with catalog observations", async () => {
  const stale = { status: "reachable", checkedAt: now - REACHABILITY_FRESH_MS - 1, surface: "https://a.example/agent" } as const;
  const current = [seller("a"), seller("b"), seller("c")];
  const prior = [seller("a", stale), seller("b"), seller("c")];
  const probed: string[] = [];
  const probe = async (surface: string): Promise<ReachabilityHint> => {
    probed.push(surface);
    return { status: "unreachable", checkedAt: now, surface };
  };

  const cursor = await refreshReachabilityHints(current, prior, { now, maxProbes: 1, concurrency: 1, probe });

  assert.equal(cursor, 1);
  assert.deepEqual(probed, ["https://a.example/agent"]);
  assert.equal(current[0].listings[0].reachabilityHint?.status, "unreachable");
  assert.equal(current[1].listings[0].reachabilityHint, undefined);
  assert.equal(current[2].listings[0].reachabilityHint, undefined);
});

test("blocked private targets are never contacted and remain unknown", async () => {
  const ipv4 = await probeReachabilitySurface("https://127.0.0.1/metadata");
  const ipv6 = await probeReachabilitySurface("https://[::1]/metadata");
  assert.equal(ipv4.status, "unknown");
  assert.equal(ipv4.surface, "https://127.0.0.1/metadata");
  assert.equal(ipv6.status, "unknown");
});

test("outbound policy rejects reserved and metadata-equivalent address forms", () => {
  for (const address of [
    "0.0.0.0", "100.100.100.200", "169.254.169.254", "192.0.0.192",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "224.0.0.1",
    "::ffff:192.0.2.1", "fd00:ec2::254",
  ]) assert.equal(isPrivateAddress(address), true, address);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});
