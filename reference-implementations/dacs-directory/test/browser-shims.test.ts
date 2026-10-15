import assert from "node:assert/strict";
import { isIP as nodeIsIP } from "node:net";
import { domainToASCII as nodeDomainToASCII } from "node:url";
import test from "node:test";

import { isIP } from "../src/shims/node-net.js";
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
