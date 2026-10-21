import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, contentHash, sha256Hex } from "../src/catalog/canonical.js";
import { artifactHash } from "../src/catalog/evidenceGraph.js";

test("canonical hash boundaries reject lone surrogates in nested strings and property names", () => {
  for (const bad of ["\ud800", "\ud801", "\udfff", "x\ud800y", "\ud800\ud800"]) {
    for (const raw of [{ nested: [{ payload: bad }] }, { nested: { [bad]: "value" } }]) {
      assert.throws(() => canonicalize(raw), /lone surrogate/);
      assert.throws(() => contentHash(raw), /lone surrogate/);
      assert.throws(() => artifactHash(raw, "listing"), /lone surrogate/);
    }
    assert.throws(() => sha256Hex(bad), /lone surrogate/);
  }
  for (const payload of ["\ufffd", "🧪", "x🧪y"]) {
    const raw = { payload };
    assert.equal(contentHash(raw), sha256Hex(canonicalize(raw)));
  }
});
