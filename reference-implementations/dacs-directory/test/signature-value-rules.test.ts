import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSignatureBytes,
  canonicalSignatureValue,
  importLegacySignatureValue,
  legacySignatureBytes,
} from "../src/catalog/signatureValue.js";

// CORE §B.7 SIG-6 at every length and boundary, beyond the 64-byte vectors in sig6.test.ts.
const bytes = (length: number, fill = (n: number) => (n * 37 + 11) & 255) => Uint8Array.from({ length }, (_, n) => fill(n));

test("canonical encoding is unpadded Base64URL at every remainder length, and decoding inverts it exactly", () => {
  for (let length = 1; length <= 66; length++) {
    const value = bytes(length);
    const encoded = canonicalSignatureValue(value);
    assert.equal(encoded, Buffer.from(value).toString("base64url"), `length ${length}`);
    assert.deepEqual(canonicalSignatureBytes(encoded, length), value, `length ${length}`);
    // The algorithm-specific length is checked separately from the wire form.
    assert.equal(canonicalSignatureBytes(encoded, length + 1), null);
    assert.equal(canonicalSignatureBytes(encoded, length - 1), null);
  }
  assert.equal(canonicalSignatureValue(new Uint8Array(0)), "");
  assert.equal(canonicalSignatureValue(Uint8Array.from([255, 255, 255])), "____");
  assert.deepEqual(canonicalSignatureBytes("____", 3), Uint8Array.from([255, 255, 255]));
});

test("a conforming decoder rejects every non-canonical spelling before any verification", () => {
  const signature = canonicalSignatureValue(bytes(64));
  for (const [name, value] of Object.entries({
    "not a string": 7, "empty": "", "an impossible length": "AAAAA", "a single character": "A",
    "an invalid character": `${signature.slice(0, -1)}.`, "a standard-Base64 plus": `+${signature.slice(1)}`, "a standard-Base64 slash": `/${signature.slice(1)}`,
    "padding": `${signature}==`, "a leading space": ` ${signature}`, "non-zero residual bits": "AB",
  })) assert.equal(canonicalSignatureBytes(value, name === "non-zero residual bits" ? 1 : 64), null, name);
  assert.deepEqual(canonicalSignatureBytes("AA", 1), Uint8Array.from([0]));
  assert.deepEqual(canonicalSignatureBytes("AAA", 2), Uint8Array.from([0, 0]));
});

test("the declared legacy import decodes only its declared encoding, strictly, and emits the canonical value", () => {
  const raw = bytes(64);
  const canonical = canonicalSignatureValue(raw);
  const hex = Buffer.from(raw).toString("hex");
  const padded = Buffer.from(raw).toString("base64");
  assert.equal(importLegacySignatureValue(hex, "lowercase-hex"), canonical);
  assert.equal(importLegacySignatureValue(padded, "standard-base64-padded"), canonical);
  for (const [name, value, declared] of [
    ["uppercase hex", hex.toUpperCase(), "lowercase-hex"], ["short hex", hex.slice(2), "lowercase-hex"], ["long hex", `${hex}00`, "lowercase-hex"],
    ["0x hex", `0x${hex}`, "lowercase-hex"], ["hex with a non-hex character", `${hex.slice(0, -1)}g`, "lowercase-hex"],
    ["unpadded standard Base64", padded.replace(/=+$/, ""), "standard-base64-padded"], ["URL-safe characters", Buffer.from(raw).toString("base64url") + "==", "standard-base64-padded"],
    ["extra padding", `${padded.replace(/=+$/, "")}===`, "standard-base64-padded"], ["the wrong length", Buffer.from(bytes(63)).toString("base64"), "standard-base64-padded"],
    ["non-zero residual bits", `${padded.slice(0, -3)}B==`, "standard-base64-padded"], ["padding inside", `${padded.slice(0, 10)}=${padded.slice(11)}`, "standard-base64-padded"],
    ["hex as Base64", hex, "standard-base64-padded"], ["no declared encoding", hex, undefined],
  ] as Array<[string, string, Parameters<typeof importLegacySignatureValue>[1]]>) assert.equal(importLegacySignatureValue(value, declared), null, name);
  // Other algorithm lengths are declared by the caller.
  assert.equal(importLegacySignatureValue(Buffer.from(bytes(65)).toString("hex"), "lowercase-hex", 65), canonicalSignatureValue(bytes(65)));
  assert.equal(importLegacySignatureValue(Buffer.from(bytes(65)).toString("base64"), "standard-base64-padded", 65), canonicalSignatureValue(bytes(65)));
});

test("the legacy-sdk-v0.1 reader accepts the draft SDK spellings of exactly 64 bytes", () => {
  const raw = bytes(64);
  const hex = Buffer.from(raw).toString("hex");
  for (const value of [hex, hex.toUpperCase(), `0x${hex}`, `0x0x${hex}`, Buffer.from(raw).toString("base64url"), Buffer.from(raw).toString("base64")]) {
    assert.deepEqual(legacySignatureBytes(value), raw, value);
  }
  for (const value of [Buffer.from(bytes(63)).toString("hex"), Buffer.from(bytes(63)).toString("base64url"), Buffer.from(bytes(65)).toString("base64url"), ""]) {
    assert.equal(legacySignatureBytes(value), null, value);
  }
});

test("presentation signatures accept exact wallet hex, Base64URL or Standard-vector Base64 and refuse malformed hex", async () => {
  const { presentationSignatureBytes } = await import("../src/catalog/signatureValue.js");
  const raw = bytes(64);
  const hex = Buffer.from(raw).toString("hex");
  for (const valid of [hex, hex.toUpperCase(), Buffer.from(raw).toString("base64url"), Buffer.from(raw).toString("base64")]) {
    assert.deepEqual(presentationSignatureBytes(valid), raw, valid);
  }
  for (const invalid of ["g".repeat(128), `${hex}junk`, `junk${hex}`, hex.slice(2), `${Buffer.from(raw).toString("base64")}=`, ` ${Buffer.from(raw).toString("base64")}`, `${Buffer.from(raw).toString("base64").slice(0, -3)}B==`]) {
    assert.equal(presentationSignatureBytes(invalid), null, invalid);
  }
});
