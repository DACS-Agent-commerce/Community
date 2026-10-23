import assert from "node:assert/strict";
import { isIP as nodeIsIP } from "node:net";
import { domainToASCII as nodeDomainToASCII } from "node:url";
import test from "node:test";

import { isIP, isIPv6 } from "../src/shims/node-net.js";
import { domainToASCII, domainToUnicode } from "../src/shims/node-url.js";

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
