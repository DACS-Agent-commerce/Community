import assert from "node:assert/strict";
import { isIP as nodeIsIP } from "node:net";
import { domainToASCII as nodeDomainToASCII } from "node:url";
import test from "node:test";

import { isIP, isIPv6 } from "../src/shims/node-net.js";
import { domainToASCII, domainToUnicode } from "../src/shims/node-url.js";

// Under Node, src/shims/buffer.ts imports node's own Buffer and replaces its `from` and `toString`, so once the
// shim is imported, Buffer's base64url output is the shim's. Node's own encoder is kept here, before that import.
const nodeToString = Buffer.prototype.toString;

// The SDK's DACS-1 DCR-2 hostname check (identity/domainHost) reaches the
// browser bundle through its ClaimReference parser. Signed-artifact readers
// take its ASCII branch: domainToASCII, then isIP on the result and the input.
const HOSTS = [
  "example.com", "agent.example.com", "xn--bcher-kva.example", "xn--zz.example", "xn--a.example",
  "a-b.example", "-a.example", "a..b", "localhost", "123.example", "1.2.3.4", "1.2.3", "01.2.3.4",
  "0x7f.1", "4294967295", "256.1.1.1", "1.2.3.4.5", "example.com.", "EXAMPLE.com", "a".repeat(64) + ".example",
  "a_b.example", "", "fe80::1", "::1", "1:2:3:4:5:6:7:8", "::ffff:1.2.3.4", "fe80::1%eth0", "fe80::1%en0/1", "fe80::1%a_b", "fe80::1%en0.5:x-y", "1::2::3", ":::", "g::1",
];

test("the browser isIP shim agrees with node:net", () => {
  for (const value of HOSTS) assert.equal(isIP(value), nodeIsIP(value), JSON.stringify(value));
});

test("the browser domainToASCII shim agrees with node:url on the reader's inputs", () => {
  for (const value of HOSTS.filter((host) => !/[:/@?#*\[\]\\%\s]/.test(host))) {
    assert.equal(domainToASCII(value), nodeDomainToASCII(value), JSON.stringify(value));
  }
});

test("the browser domainToUnicode shim fails the producer path closed", () => {
  assert.equal(domainToUnicode("xn--bcher-kva.example"), "");
});

test("browser IP parsing refuses malformed zones and address suffixes", () => {
  for (const value of ["fe80::1%bad%eth0", "::1]/x"]) {
    assert.equal(nodeIsIP(value), 0);
    assert.equal(isIP(value), 0, value);
  }
});

test("direct browser IPv6 parsing returns strict false on malformed addresses", () => {
  for (const value of ["1::2::3", ":::x", "g::1", "::1]/x"]) assert.equal(isIPv6(value), false, value);
  assert.equal(isIPv6("::1"), true);
});

test("browser util predicates distinguish byte arrays from ordinary JSON", async () => {
  const { types } = await import("../src/shims/node-util.js");
  assert.equal(typeof types.isProxy, "function");
  assert.equal(typeof types.isUint8Array, "function");
  assert.equal(types.isProxy({ answer: 42 }), false);
  assert.equal(types.isUint8Array(new Uint8Array([1, 2])), true);
  assert.equal(types.isUint8Array({ 0: 1, length: 1 }), false);
});


test("browser IP entry points refuse non-string runtime inputs without coercion", () => {
  for (const value of [null, undefined, 7, {}, ["127.0.0.1"], ["::1"]]) {
    assert.equal(isIPv6(value as unknown as string), false);
    assert.equal(isIP(value as unknown as string), 0);
  }
});

test("the browser Buffer shim encodes and decodes base64url like node:buffer", async () => {
  // The browser bundle's Buffer is src/shims/buffer.ts wrapping the npm `buffer` package; `buffer/` resolves that package under Node.
  const { createRequire } = await import("node:module");
  const { randomBytes } = await import("node:crypto");
  const { addBase64url } = await import("../src/shims/buffer.js");
  const Polyfill = addBase64url(createRequire(import.meta.url)("buffer/").Buffer);
  // The SDK's bundle verifier runs this when its module loads.
  assert.equal(Polyfill.alloc(64).toString("base64url"), "A".repeat(86));
  // #214: fixed vectors (RFC 4648 §5 alphabet, no padding): one and two trailing bytes, and '-' and '_'.
  const VECTORS: [number[], string][] = [
    [[], ""], [[0x66], "Zg"], [[0x66, 0x6f], "Zm8"], [[0x66, 0x6f, 0x6f], "Zm9v"],
    [[0xfb, 0xff], "-_8"], [[0xff, 0xfe], "__4"], [[0xfb, 0xef, 0xbe], "----"], [[0xff, 0xff, 0xff], "____"],
  ];
  for (const [bytes, encoded] of VECTORS) {
    assert.equal(Polyfill.from(bytes).toString("base64url"), encoded, `encode ${bytes}`);
    assert.deepEqual(Uint8Array.from(Polyfill.from(encoded, "base64url")), Uint8Array.from(bytes), `decode ${encoded}`);
  }
  for (let length = 0; length <= 70; length += 1) {
    const bytes = randomBytes(length);
    const encoded = nodeToString.call(bytes, "base64url");
    assert.equal(Polyfill.from(bytes).toString("base64url"), encoded, `encode ${length}`);
    assert.deepEqual(Uint8Array.from(Polyfill.from(encoded, "base64url")), Uint8Array.from(bytes), `decode ${length}`);
  }
  assert.equal(Polyfill.from("hello").toString("hex"), "68656c6c6f", "other encodings are unchanged");
});
