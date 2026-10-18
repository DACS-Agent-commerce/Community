import assert from "node:assert/strict";
import test from "node:test";
import { assertValidUnicode, canonicalize, contentHash, sha256Hex, listingAddress } from "../src/catalog/canonical.js";

test("canonical wrappers reject lone surrogates in nested values and keys", () => {
  for (const text of ["\ud800", "\udfff", "prefix\ud800tail", "\ud800\ud800", "\udfff\ud800"]) {
    for (const value of [{ nested: [text] }, { nested: [{ [text]: "value" }] }]) {
      assert.throws(() => assertValidUnicode(value), /lone surrogate/);
      assert.throws(() => canonicalize(value), /lone surrogate/);
      assert.throws(() => contentHash(value), /lone surrogate/);
    }
    assert.throws(() => sha256Hex(text), /lone surrogate/);
    assert.throws(() => listingAddress(text, "svc", 1), /lone surrogate/);
  }
});

test("valid surrogate pairs and NFC-equivalent keys and values retain canonical hashes", () => {
  const a = { "café": ["élève", "😀"] };
  const b = { "cafe\u0301": ["e\u0301le\u0300ve", "\ud83d\ude00"] };
  assert.doesNotThrow(() => assertValidUnicode(a));
  assert.equal(canonicalize(a), canonicalize(b));
  assert.equal(contentHash(a), contentHash(b));
  assert.equal(sha256Hex(canonicalize(a)), sha256Hex(canonicalize(b)));
  assert.equal(sha256Hex("😀"), sha256Hex("\ud83d\ude00"));
  assert.equal(listingAddress("did:example:😀", "svc", 1), listingAddress("did:example:\ud83d\ude00", "svc", 1));
  assert.doesNotThrow(() => listingAddress("did:example:cafe\u0301", "svc", 1));
});

test("canonical Unicode guard pins surrogate range boundaries", () => {
  for (const text of ["\ud800\ue000", "\ud800\uffff", "\udc00"]) {
    assert.throws(() => assertValidUnicode(text), /lone surrogate/);
    assert.throws(() => canonicalize(text), /lone surrogate/);
    assert.throws(() => contentHash({ text }), /lone surrogate/);
    assert.throws(() => sha256Hex(text), /lone surrogate/);
  }
  for (const text of ["\uff0c", "\ufffd", "\udbff\udfff", "\ud800\udc00", "\ud83d\udc00"]) {
    assert.doesNotThrow(() => assertValidUnicode(text));
    assert.doesNotThrow(() => canonicalize(text));
    assert.doesNotThrow(() => contentHash({ text }));
    assert.doesNotThrow(() => sha256Hex(text));
  }
});
