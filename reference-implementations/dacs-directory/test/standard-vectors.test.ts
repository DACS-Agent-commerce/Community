import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { canonicalDemosAgentClaim } from "../src/catalog/claimRef.js";
import { canonicalSignatureBytes, importLegacySignatureValue, type LegacySignatureEncoding } from "../src/catalog/signatureValue.js";

function fixture(name: string, hash: string) {
  const bytes = readFileSync(new URL(`./fixtures/dacs-standard/${name}`, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, `${name} must remain byte-identical to its upstream pin`);
  return JSON.parse(bytes.toString("utf8"));
}

test("pinned SIG-6 vectors exercise canonical decoding and declared legacy import", () => {
  const set = fixture("signature-value-encoding-v0.1.json", "bf47cd0a42b0e0e30f2ff032327395d5a1b820758e6188c51212eb9129ba8312");
  assert.equal(set.vectors.length, set.count);
  for (const vector of set.vectors) {
    if (vector.mode === "legacy-import") {
      const value = importLegacySignatureValue(vector.value, vector.declaredEncoding as LegacySignatureEncoding | undefined);
      assert.equal(value !== null, vector.expected === "accept", vector.name);
      if (value !== null) assert.equal(value, vector.want.canonicalValue, vector.name);
    } else {
      const bytes = canonicalSignatureBytes(vector.value);
      assert.equal(bytes !== null, vector.expected === "accept", vector.name);
      if (bytes) {
        assert.equal(bytes.length, vector.want.decodedLength);
        assert.equal(Buffer.from(bytes).toString("hex"), set.signatureBytesHex);
      }
    }
  }
});

test("pinned Demos agent claim fixture exercises canonical claim resolution", () => {
  const set = fixture("demos-agent-claim-reference.json", "0e70d2c12d9d4dd14d676519e1841b12767051153044659adcadbf8a3c994933");
  assert.equal(set.cases.length, 4);
  for (const vector of set.cases) {
    const claim = canonicalDemosAgentClaim(vector.input);
    assert.equal(claim !== null, vector.expected.accepted, vector.id);
    assert.equal(claim, vector.expected.canonical, vector.id);
  }
});
