import assert from "node:assert/strict";
import test from "node:test";

import { parseDemosAgentClaimReference, sameCanonicalClaimIdentity } from "@kynesyslabs/dacs/identity";

import {
  canonicalDemosAgentClaim,
  canonicalDemosAgentReference,
  isCanonicalDemosAgentClaim,
} from "../src/catalog/claimRef.js";
import { canonicalSigningIdentity, resolveDemosPrimaryClaimKey } from "../src/catalog/primaryClaimKey.js";

const key = "ab".repeat(32);
const claim = `did:demos:agent:${key}`;

// claimRef.ts cannot import the SDK identity tree (it loads node:net and the
// module also runs in the browser), so it mirrors parseDemosAgentClaimReference.
const CASES = [
  claim,
  `DID:demos:agent:${key}`,
  `DiD:demos:agent:${key}`,
  `${claim}?channel=directory`,
  `${claim}?channel=directory&purpose=listing`,
  `${claim}?a=`,
  `${claim}?a=%3A%3F%26%3D%25`,
  `${claim}?café=1`,
  `${claim}?b=1&a=2`,
  `${claim}?a=1&a=2`,
  `${claim}?`,
  `${claim}?a`,
  `${claim}?=1`,
  `${claim}?a=1=2`,
  `${claim}?a=b?c`,
  `${claim}?a=b:c`,
  `${claim}?a=%41`,
  `${claim}?a=%3a`,
  `${claim}?a=%3`,
  `${claim}?a=%GG`,
  `${claim}?a=%7F`,
  `${claim}?a=\u0000`,
  `${claim}?a=\u007f`,
  `${claim}?a=1&`,
  `${claim}?a=b c`,
  `${claim}?a=b\n`,
  `${claim}?café=1`,
  `did:demos:agent:${key.toUpperCase()}`,
  `did:DEMOS:agent:${key}`,
  `did:demos:agent:${key}0`,
  `did:demos:agent:${key.slice(2)}`,
  `did:demos:agent:${key}:extra`,
  `did:demos:buyer`,
  `did:other:agent:${key}`,
  `demos:0x${key}`,
  `domain:${key}`,
  ` ${claim}`,
  key,
  "",
];

test("the Demos ClaimReference parser matches the SDK's CF-2 read and CF-3 identity", () => {
  for (const value of CASES) {
    const sdk = parseDemosAgentClaimReference(value);
    assert.equal(canonicalDemosAgentClaim(value), sdk?.canonicalIdentity ?? null, JSON.stringify(value));
    assert.equal(canonicalDemosAgentReference(value), sdk?.canonicalReference ?? null, JSON.stringify(value));
  }
});

test("advisory parameters do not change identity, resolution, or the registration form", async () => {
  const advisory = `${claim}?channel=directory`;
  assert.equal(sameCanonicalClaimIdentity(advisory, claim), true);
  assert.equal(canonicalSigningIdentity(advisory), canonicalSigningIdentity(claim));
  const resolved = await resolveDemosPrimaryClaimKey(advisory, "ed25519");
  assert.equal(resolved?.canonicalClaim, claim);
  assert.deepEqual(resolved?.publicKey, Uint8Array.from(Buffer.from(key, "hex")));
  assert.equal(await resolveDemosPrimaryClaimKey(`${claim}?b=1&a=2`, "ed25519"), null);
  // Registrations and other Directory-issued claims stay parameter-free.
  assert.equal(isCanonicalDemosAgentClaim(claim), true);
  assert.equal(isCanonicalDemosAgentClaim(advisory), false);
});

test("canonical references reject leading junk and order decoded keys including prefixes", () => {
  const cases: Array<[string, string | null]> = [
    [`prefix${claim}`, null],
    [`${claim}?a=1&aa=2`, `${claim}?a=1&aa=2`],
    [`${claim}?aa=1&a=2`, null],
    [`${claim}?ab=1&aa=2`, null],
    [`DID:demos:agent:${key}?a%3A=1&a%3F=2`, `${claim}?a%3A=1&a%3F=2`],
  ];
  for (const [input, expected] of cases) {
    assert.equal(canonicalDemosAgentReference(input), expected, input);
    assert.equal(canonicalDemosAgentClaim(input), expected === null ? null : claim, input);
    assert.equal(parseDemosAgentClaimReference(input)?.canonicalReference ?? null, expected, input);
  }
});


test("large canonical parameter sets remain bounded and reject late duplicates or disorder", () => {
  const parameters = Array.from({ length: 60_000 }, (_, index) => `k${String(index).padStart(5, "0")}=v`);
  const reference = `${claim}?${parameters.join("&")}`;
  const started = performance.now();
  assert.equal(canonicalDemosAgentClaim(reference), claim);
  assert.ok(performance.now() - started < 1500, "60,000 parameters must parse within a generous linear-work budget");
  assert.equal(canonicalDemosAgentClaim(`${reference}&${parameters.at(-1)}`), null);
  assert.equal(canonicalDemosAgentClaim(`${reference}&a=last`), null);
});
