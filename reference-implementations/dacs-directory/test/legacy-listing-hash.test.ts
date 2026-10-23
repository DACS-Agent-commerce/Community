import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { legacyListingHash } from "../src/catalog/legacyListingHash.js";
import { canonicalize } from "../src/catalog/canonical.js";

const digest = (preimage: string) => createHash("sha256").update(preimage, "utf8").digest("hex");

test("historical member ordering is stable across large insertion permutations and NFC collisions", () => {
  const keys = Array.from({ length: 48 }, (_, index) => `k${String(index).padStart(2, "0")}`);
  const ordinary = keys.map((key, index) => [key, index] as const);
  const sortedPreimage = ordinary.map(([key, value]) => `"${key}":${value}`).join(",");
  for (let rotation = 0; rotation < keys.length; rotation++) {
    const rotated = [...ordinary.slice(rotation), ...ordinary.slice(0, rotation)];
    if (rotation % 2) rotated.reverse();
    for (const reverseCollision of [false, true]) {
      const colliding: Array<[string, string]> = [["e\u0301", "decomposed"], ["é", "composed"]];
      if (reverseCollision) colliding.reverse();
      const scope = Object.fromEntries([...colliding, ...rotated]);
      // The draft normalized names before a stable sort, retaining both members.
      // This preimage intentionally contains duplicate normalized member names.
      const collisionPreimage = colliding.map(([, value]) => `"é":"${value}"`).join(",");
      assert.equal(legacyListingHash(scope), digest(`{${sortedPreimage},${collisionPreimage}}`));
      // Current canonicalization preserves the original, distinct member names.
      assert.match(canonicalize(scope), /"é":"decomposed"/);
      assert.match(canonicalize(scope), /"é":"composed"/);
    }
  }
});

test("historical hashes refuse non-integer numbers at every nested position", () => {
  for (const value of [0.5, -0.5, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, NaN, Infinity]) {
    for (const scope of [{ value }, { nested: { value } }, { nested: [{ value }] }, { nested: [value] }]) {
      assert.throws(() => legacyListingHash(scope), /legacy canonical form requires safe integers/);
    }
  }
  for (const value of [0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
    const scope = { nested: [value] };
    assert.equal(legacyListingHash(scope), digest(`{"nested":[${value}]}`));
  }
  assert.equal(canonicalize({ nested: [0.5] }), '{"nested":[0.5]}');
});

test("historical NFC-equal members keep insertion order across separate sorting runs", () => {
  const names = ["s\u0323\u0307", "s\u0307\u0323", "ṣ\u0307", "ṩ"];
  const ordinary = Array.from({ length: 160 }, (_, i) => [`k${String(i).padStart(3, "0")}`, i] as const);
  const sorted = ordinary.map(([key, value]) => `"${key}":${value}`);
  for (const order of [names, [...names].reverse()]) {
    const members: Array<readonly [string, number]> = [];
    for (let i = 0; i < order.length; i++) {
      members.push([order[i], i], ...ordinary.slice(i * 40, (i + 1) * 40).reverse());
    }
    assert.equal(new Set(order.map(name => name.normalize("NFC"))).size, 1);
    // Construct the frozen preimage independently, without sorting normalized keys.
    const collisions = order.map((_, i) => `"ṩ":${i}`);
    assert.equal(legacyListingHash(Object.fromEntries(members)), digest(`{${[...sorted, ...collisions].join(",")}}`));
  }
});

test("historical equal-name stability spans a galloping merge between long sorted runs", () => {
  const lower = Array.from({ length: 96 }, (_, i) => [`a${String(i).padStart(3, "0")}`, i] as const);
  const firstHigher = Array.from({ length: 63 }, (_, i) => [`\uf000${String(i).padStart(3, "0")}`, i] as const);
  const lastHigher = Array.from({ length: 96 }, (_, i) => [`\uf100${String(i).padStart(3, "0")}`, i] as const);
  const encode = ([key, value]: readonly [string, number]) => `${JSON.stringify(key)}:${value}`;
  for (const names of [["e\u0301", "é"], ["é", "e\u0301"]]) {
    const first = [names[0], 1000] as const, second = [names[1], 2000] as const;
    // Two separately ascending runs: the second's long lower-key prefix forces
    // the merge to batch comparisons immediately before the NFC-equal members.
    const scope = Object.fromEntries([first, ...firstHigher, ...lower, second, ...lastHigher]);
    const expected = `{${[...lower.map(encode), '\"é\":1000', '\"é\":2000',
      ...firstHigher.map(encode), ...lastHigher.map(encode)].join(",")}}`;
    assert.equal(legacyListingHash(scope), digest(expected));
  }
});
