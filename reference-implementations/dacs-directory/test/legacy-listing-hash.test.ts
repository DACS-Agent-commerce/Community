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
