import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  BAD_PORTS,
  DOCUMENTATION_SUFFIXES,
  GLOBAL_UNICAST_IPV6_SUBNETS,
  NON_PUBLIC_IPV4_SUBNETS,
  NON_PUBLIC_IPV6_SUBNETS,
  NON_PUBLIC_SUFFIXES,
  checkDirectoryOrigin,
  httpsOrigin,
} from "../scripts/check-directory-origin.mjs";
import { cpythonRows, dnsNames, fetchBadPorts, wiresharkRows } from "../scripts/verify-origin-sources.mjs";

const sources = JSON.parse(readFileSync(new URL("./fixtures/origin-policy-sources.json", import.meta.url), "utf8"));

function assertPublic(value) {
  assert.equal(httpsOrigin({ NEXT_PUBLIC_DIRECTORY_URL: value }, "NEXT_PUBLIC_DIRECTORY_URL"), value);
}

function assertNotPublic(value) {
  assert.throws(
    () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
    /NEXT_PUBLIC_DIRECTORY_URL must be a public host/,
    value,
  );
}

test("accepts and canonicalizes a production HTTPS directory origin", () => {
  assert.equal(
    httpsOrigin({ NEXT_PUBLIC_DIRECTORY_URL: "https://directory.dacs.dev/" }, "NEXT_PUBLIC_DIRECTORY_URL"),
    "https://directory.dacs.dev",
  );
  assert.equal(
    checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: "https://directory.dacs.dev" } }),
    "Production directory origin valid: https://directory.dacs.dev",
  );
  for (const value of [
    "https://directory.dacs.dev:8443",
    "https://directory.dacs.dev:6001",
    "https://8.8.8.8",
    "https://172.32.0.1",
    "https://[2606:4700::1111]",
    "https://localhost-directory.dacs.dev",
    "https://directory.local.dacs.dev",
    "https://directory.example.dacs.dev",
    "https://directory.notlocal",
    "https://directory.notinternal",
    "https://directory.notexample",
    "https://directory.arpa-mirror.org",
  ]) assertPublic(value);
});

// Boundary vectors just outside each blocked range, so no range can grow. Some
// (3fff:1000::/20 upwards, 2d00::/8) are unallocated rather than routed today.
test("accepts addresses next to each blocked range", () => {
  for (const value of [
    "https://1.1.1.1",
    "https://11.0.0.0",
    "https://100.63.255.255",
    "https://100.128.0.0",
    "https://126.255.255.255",
    "https://128.0.0.0",
    "https://169.253.255.255",
    "https://169.255.0.0",
    "https://172.15.255.255",
    "https://192.0.1.1",
    "https://192.0.3.0",
    "https://192.31.195.255",
    "https://192.31.197.0",
    "https://192.52.192.255",
    "https://192.52.194.0",
    "https://192.88.98.255",
    "https://192.88.100.0",
    "https://192.167.255.255",
    "https://192.169.0.0",
    "https://192.175.47.255",
    "https://192.175.49.0",
    "https://198.17.255.255",
    "https://198.20.0.1",
    "https://198.51.99.255",
    "https://198.51.101.0",
    "https://203.0.112.255",
    "https://203.0.114.0",
    "https://223.255.255.255",
    "https://[2000::1]",
    "https://[2001:200::1]",
    "https://[2001:db7:ffff::1]",
    "https://[2001:db9::1]",
    "https://[2003::1]",
    "https://[2620:4f:7fff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2620:4f:8001::]",
    "https://[3fff:1000::1]",
    "https://[3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
  ]) assertPublic(value);
});

test("rejects missing, insecure, or non-origin deployment URLs", () => {
  assert.throws(
    () => checkDirectoryOrigin({ env: {} }),
    /NEXT_PUBLIC_DIRECTORY_URL is required/,
  );
  assert.throws(
    () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: "http://directory.dacs.dev" } }),
    /NEXT_PUBLIC_DIRECTORY_URL must use HTTPS/,
  );
  for (const value of [
    "https://user@directory.dacs.dev",
    "https://:secret@directory.dacs.dev",
    "https://directory.dacs.dev/path",
    "https://directory.dacs.dev?mode=test",
    "https://directory.dacs.dev#fragment",
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must be an origin without credentials, path, query, or fragment/,
      value,
    );
  }
  for (const [value, port] of [
    ["https://directory.dacs.dev:0", "0"],
    ["https://directory.dacs.dev:00/", "0"],
    ["https://directory.dacs.dev:1", "1"],
    ["https://directory.dacs.dev:22", "22"],
    ["https://directory.dacs.dev:25", "25"],
    ["https://directory.dacs.dev:6000", "6000"],
    ["https://directory.dacs.dev:6667", "6667"],
    ["https://directory.dacs.dev:10080", "10080"],
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      new RegExp(`NEXT_PUBLIC_DIRECTORY_URL must not use port ${port}, which browsers refuse to fetch`),
      value,
    );
  }
  for (const value of ["directory.dacs.dev", "https://directory.dacs.dev:65536", "https://"]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must be an absolute URL/,
      value,
    );
  }
  for (const value of ["ftp://directory.dacs.dev", "ws://directory.dacs.dev", "wss://directory.dacs.dev"]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must use HTTPS/,
      value,
    );
  }
});

// directory.dacs.dev. is a different origin from the dotless host the site is served on.
test("rejects a fully qualified host name with a trailing dot", () => {
  for (const value of ["https://directory.dacs.dev.", "https://directory.dacs.dev./"]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must not end its host name with a dot/,
      value,
    );
  }
});

// The app reads the raw variable (src/catalog/publicUrl.ts), so a value that only
// parses to a valid origin would still leak into canonical URLs and the sitemap.
test("rejects values that the app would not use verbatim as the origin", () => {
  for (const value of [
    " https://directory.dacs.dev",
    "https://directory.dacs.dev/ ",
    "https://directory.dacs.dev?",
    "https://directory.dacs.dev/#",
    "https://DIRECTORY.dacs.dev",
    "https://directory.dacs.dev:443",
  ]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value } }),
      /NEXT_PUBLIC_DIRECTORY_URL must be written exactly as its origin/,
      value,
    );
  }
});

test("rejects loopback, unspecified, private, and local-only hosts", () => {
  for (const value of [
    "https://localhost",
    "https://localhost/",
    "https://localhost.",
    "https://directory.localhost",
    "https://127.0.0.1",
    "https://127.8.9.10",
    "https://0.0.0.0",
    "https://0.1.2.3",
    "https://[::1]",
    "https://[::]",
    "https://[::ffff:7f00:1]",
    "https://10.1.2.3",
    "https://172.16.0.1",
    "https://172.31.255.254",
    "https://192.168.1.10",
    "https://169.254.169.254",
    "https://100.64.0.1",
    "https://100.127.255.255",
    "https://[fe80::1]",
    "https://[febf::1]",
    "https://[fd00::1]",
    "https://directory.local",
    "https://directory.local.",
  ]) assertNotPublic(value);
});

test("rejects single-label, malformed, and private-use names", () => {
  for (const value of [
    "https://directory",
    "https://local",
    "https://ip6-localhost",
    "https://.",
    "https://localhost..",
    "https://directory.local..",
    "https://directory.dacs.dev..",
    "https://directory..dacs.dev",
    "https://directory.internal",
    "https://directory.railway.internal",
    "https://router.home.arpa",
    "https://home.arpa",
    "https://localhost.localdomain",
    "https://directory.invalid",
    "https://directory.onion",
    "https://directory.alt",
    "https://directory.eap-noob.arpa",
  ]) assertNotPublic(value);
});

// The port must not hide the host from the check (url.hostname, not url.host).
test("rejects non-public hosts that carry a port", () => {
  for (const value of [
    "https://127.0.0.1:8443",
    "https://10.0.0.1:8443",
    "https://directory.local:8443",
    "https://[::1]:8443",
  ]) assertNotPublic(value);
});

// IPv4-mapped IPv6 is outside global unicast whatever IPv4 address it carries.
test("rejects IPv4-mapped IPv6 literals", () => {
  for (const value of [
    "https://[::ffff:808:808]",
    "https://[::ffff:dfff:ffff]",
    "https://[::ffff:1.1.1.1]",
    "https://[::ffff:0:0]",
    "https://[::ffff:ffff:ffff]",
  ]) assertNotPublic(value);
});

test("rejects every special-use name and its subdomains", () => {
  for (const [name] of [...sources.names.specialUse, ...sources.names.extraRejections]) {
    assertNotPublic(`https://${name}`);
    assertNotPublic(`https://directory.${name}`);
  }
  for (const value of ["https://1.0.0.127.in-addr.arpa", "https://directory.6tisch.arpa"]) {
    assertNotPublic(value);
  }
});

// CI builds with a placeholder documentation origin; only its explicitly flagged
// check accepts one, so a production build can't.
test("rejects documentation names unless they are explicitly allowed", () => {
  for (const [name] of sources.names.documentation) {
    for (const host of [name, `directory.${name}`]) {
      if (!host.includes(".")) continue;
      assertNotPublic(`https://${host}`);
      assert.equal(
        checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: `https://${host}` }, allowDocumentationNames: true }),
        `Directory origin valid (documentation names allowed; not a production check): https://${host}`,
      );
    }
  }
  assert.throws(
    () => httpsOrigin({ ORIGIN: "https://directory.example" }, "ORIGIN"),
    /ORIGIN must be a public host/,
  );
  for (const value of ["https://directory.test", "https://directory.local", "https://10.0.0.1"]) {
    assert.throws(
      () => checkDirectoryOrigin({ env: { NEXT_PUBLIC_DIRECTORY_URL: value }, allowDocumentationNames: true }),
      /NEXT_PUBLIC_DIRECTORY_URL must be a public host/,
      value,
    );
  }
});

// Only globally routable unicast literals can be this deployment's public origin.
test("rejects special-use, documentation, multicast, and reserved IP literals", () => {
  for (const value of [
    "https://192.0.0.192",
    "https://192.0.2.1",
    "https://192.31.196.1",
    "https://192.52.193.1",
    "https://192.175.48.1",
    "https://192.88.99.1",
    "https://198.18.0.1",
    "https://198.19.255.255",
    "https://198.51.100.1",
    "https://203.0.113.1",
    "https://224.0.0.1",
    "https://239.255.255.255",
    "https://240.0.0.1",
    "https://255.255.255.255",
    "https://[::ffff:192.0.2.1]",
    "https://[::ffff:224.0.0.1]",
    "https://[2001:db8::1]",
    "https://[3fff::1]",
    "https://[3fff:fff::1]",
    "https://[2001::1]",
    "https://[2001:1ff::1]",
    "https://[2620:4f:8000::1]",
    "https://[fec0::1]",
    "https://[ff02::1]",
    "https://[100::1]",
    "https://[100:0:0:1::1]",
    "https://[1fff:ffff::1]",
    "https://[4000::1]",
  ]) assertNotPublic(value);
});

// The last address inside each blocked range, so no range can shrink.
test("rejects the upper edge of each blocked range", () => {
  for (const value of [
    "https://0.255.255.255",
    "https://10.255.255.255",
    "https://127.255.255.255",
    "https://169.254.255.255",
    "https://172.31.255.255",
    "https://192.0.0.255",
    "https://192.0.2.255",
    "https://192.88.99.255",
    "https://192.168.255.255",
    "https://198.51.100.255",
    "https://203.0.113.255",
    "https://[1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2001:db8:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff]",
    "https://[::fffe:808:808]",
  ]) assertNotPublic(value);
});

// Transition prefixes carry an IPv4 address the check would otherwise not classify.
test("rejects IPv6 transition forms that embed an IPv4 address", () => {
  for (const value of [
    "https://[64:ff9b::7f00:1]",
    "https://[64:ff9b:1::a00:1]",
    "https://[2002:7f00:1::]",
    "https://[2002:808:808::1]",
    "https://[::7f00:1]",
    "https://[::ffff:0:7f00:1]",
  ]) assertNotPublic(value);
});

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

// docs/codex-local-workflow.md reruns CI's origin check and build locally, so
// every origin it passes must be CI's own value, and that value must pass.
test("the local verification guide passes only CI's placeholder origin", () => {
  const ciEnv = Object.fromEntries(
    [...read("../../../.github/workflows/dacs-directory-ci.yml").matchAll(/^ +(NEXT_PUBLIC_\w+): (\S+)$/gm)]
      .map(([, name, value]) => [name, value]),
  );
  assert.equal(
    checkDirectoryOrigin({ env: ciEnv, allowDocumentationNames: true }),
    `Directory origin valid (documentation names allowed; not a production check): ${ciEnv.NEXT_PUBLIC_DIRECTORY_URL}`,
  );

  const guide = read("../../../docs/codex-local-workflow.md");
  const assignments = [...guide.matchAll(/\b(NEXT_PUBLIC_\w+)=(\S+)/g)];
  assert.ok(assignments.length > 0, "the guide no longer passes an origin to the checks");
  for (const [, name, value] of assignments) assert.equal(value, ciEnv[name], name);
  // CI's origin is a documentation name, so the strict check would fail on it.
  const checks = [...guide.matchAll(/npm run check:deploy-config.*$/gm)].map(([line]) => line);
  assert.ok(checks.length > 0, "the guide no longer runs the origin check");
  for (const line of checks) assert.equal(line, "npm run check:deploy-config -- --allow-documentation-names");
  // The retired gateway demo's Butler origin and live/paid browser suite.
  assert.doesNotMatch(guide, /butler|live_paid|live\/paid/i);
});

// Only CI's placeholder check may allow documentation names; Railway's
// production build must run the strict check.
test("only CI's placeholder check allows documentation names", () => {
  const ci = read("../../../.github/workflows/dacs-directory-ci.yml");
  assert.match(ci, /run: npm run check:deploy-config -- --allow-documentation-names$/m);
  const railway = JSON.parse(read("../railway.json"));
  assert.match(railway.build.buildCommand, /^npm run check:node-runtime && npm run check:deploy-config && /);
  assert.doesNotMatch(railway.build.buildCommand, /allow-documentation-names/);
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.scripts["check:deploy-config"], "node scripts/check-directory-origin.mjs");
});

function subnetRange(network, prefix) {
  const family = isIP(network);
  const bits = family === 4 ? 32 : 128;
  const value = family === 4
    ? network.split(".").reduce((acc, part) => (acc << 8n) | BigInt(part), 0n)
    : expandIpv6(network).reduce((acc, part) => (acc << 16n) | BigInt(`0x${part}`), 0n);
  const hostMask = (1n << BigInt(bits - prefix)) - 1n;
  return [value & ~hostMask, value | hostMask];
}

function subnetEdges(network, prefix) {
  return subnetRange(network, prefix).map((n) => formatAddress(n, isIP(network)));
}

function covers([network, prefix], [inner, innerPrefix]) {
  const [low, high] = subnetRange(network, prefix);
  const [innerLow, innerHigh] = subnetRange(inner, innerPrefix);
  return low <= innerLow && innerHigh <= high;
}

function expandIpv6(address) {
  const [head, tail = ""] = address.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
}

function formatAddress(n, family) {
  if (family === 4) return [24n, 16n, 8n, 0n].map((shift) => String((n >> shift) & 255n)).join(".");
  return `[${[112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((shift) => ((n >> shift) & 0xffffn).toString(16)).join(":")}]`;
}

// test/fixtures/origin-policy-sources.json pins the upstream tables. Every
// not-globally-reachable block and every deliberate rejection must be rejected at
// both edges, and every module entry must trace to a pinned row or a listed extra.
test("the denylists match the pinned registry snapshot", () => {
  for (const family of ["ipv4", "ipv6"]) {
    const { notGloballyReachable, globallyReachableButRejected, extraRejections } = sources[family];
    for (const [network, prefix] of [...notGloballyReachable, ...globallyReachableButRejected, ...extraRejections]) {
      for (const edge of subnetEdges(network, prefix)) assertNotPublic(`https://${edge}`);
    }
    const traced = new Set(
      [...notGloballyReachable, ...globallyReachableButRejected, ...extraRejections].map(([n, p]) => `${n}/${p}`),
    );
    const moduleRows = family === "ipv4" ? NON_PUBLIC_IPV4_SUBNETS : NON_PUBLIC_IPV6_SUBNETS;
    for (const [network, prefix] of moduleRows) assert.ok(traced.has(`${network}/${prefix}`), `${network}/${prefix}`);
  }
  assert.deepEqual(GLOBAL_UNICAST_IPV6_SUBNETS, [["2000::", 3]]);

  const names = new Set([...sources.names.specialUse, ...sources.names.extraRejections].map(([name]) => name));
  for (const suffix of NON_PUBLIC_SUFFIXES) {
    assert.ok(names.has(suffix) || [...names].some((name) => name.endsWith(`.${suffix}`)), suffix);
  }
  assert.deepEqual(DOCUMENTATION_SUFFIXES, sources.names.documentation.map(([name]) => name));
  assert.deepEqual([...BAD_PORTS], sources.badPorts.ports);
});

// registryRows is every row of the pinned registry copy. Each is rejected at both
// edges, and none is missing from the tables above: a not-globally-reachable row
// sits inside a notGloballyReachable row, a globally reachable one inside a
// row that is rejected anyway.
test("every IANA special-purpose block is rejected and traced", () => {
  for (const family of ["ipv4", "ipv6"]) {
    const { registryRows, notGloballyReachable, globallyReachableButRejected } = sources[family];
    assert.ok(registryRows.length >= 24, family);
    for (const [network, prefix, globallyReachable, name] of registryRows) {
      for (const edge of subnetEdges(network, prefix)) assertNotPublic(`https://${edge}`);
      const listed = globallyReachable
        ? [...notGloballyReachable, ...globallyReachableButRejected]
        : notGloballyReachable;
      assert.ok(listed.some((row) => covers(row, [network, prefix])), `${family} ${network}/${prefix} ${name}`);
    }
  }
});

// `npm run verify:origin-sources` fetches these; each pin must name an exact
// upstream revision, a sha256, and the cited lines.
test("every pinned copy names a fixed revision, a sha256, and its lines", () => {
  for (const [id, copy] of Object.entries(sources.pinnedCopies)) {
    assert.match(copy.url, /^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/([0-9a-f]{40}|v\d+\.\d+\.\d+)\//, id);
    assert.match(copy.sha256, /^[0-9a-f]{64}$/, id);
    for (const [first, last] of Array.isArray(copy.lines) ? [copy.lines] : Object.values(copy.lines)) {
      assert.ok(Number.isInteger(first) && first > 0 && last >= first, id);
    }
  }
  assert.match(sources.asOf, /^\d{4}-\d{2}-\d{2}$/);
});

test("the source verifier extracts rows the way the pinned copies write them", () => {
  assert.deepEqual(
    wiresharkRows([
      '\t{ 4, { .ipv4 = { 0xc01fc400, 0xffffff00 } }, "AS112-v4", true, true, true, true, false },',
      "\t{ 6, { .ipv6 = { { { 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 } }, 64 } },",
      '\t\t"Dummy IPv6 Prefix", true, false, false, false, false },',
      "\t{ 6, { .ipv6 = { { { 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01 } }, 128 } },",
      '\t\t"Loopback Address", false, false, false, false, true },',
    ].join("\n")),
    [
      ["192.31.196.0", 24, true, "AS112-v4"],
      ["100:0:0:1::", 64, false, "Dummy IPv6 Prefix"],
      ["::1", 128, false, "Loopback Address"],
    ],
  );
  assert.deepEqual(
    cpythonRows("        IPv4Network('192.0.0.170/31'),\n        IPv6Network('2001:4:112::/48'),"),
    [["192.0.0.170", 31], ["2001:4:112::", 48]],
  );
  assert.deepEqual(dnsNames('\t"home.arpa.",\t\t/* RFC 8375 */\n\t{ KR_RULE_SUB_NXDOMAIN, "eap-noob.arpa."},'), [
    "home.arpa",
    "eap-noob.arpa",
  ]);
  assert.deepEqual(fetchBadPorts(" <tbody><tr><th>Port<th>Typical service\n <tr><td>0<td>—\n <tr><td>10080<td>amanda"), [0, 10080]);
});

const script = fileURLToPath(new URL("../scripts/check-directory-origin.mjs", import.meta.url));

// The child inherits this process's environment, which can turn on runtime
// warnings (NODE_USE_ENV_PROXY behind a proxy prints one at startup). Silence them
// so the assertions see only the script's own output.
function childEnv(value, extra = {}) {
  const env = { ...process.env, ...extra, NODE_NO_WARNINGS: "1" };
  delete env.NEXT_PUBLIC_DIRECTORY_URL;
  if (value !== undefined) env.NEXT_PUBLIC_DIRECTORY_URL = value;
  return env;
}

function runCli(value, { args = [], path = script, env = {} } = {}) {
  return spawnSync(process.execPath, [path, ...args], { env: childEnv(value, env), encoding: "utf8" });
}

// railway.json and CI rely only on the exit status of check:deploy-config.
test("the CLI exits non-zero on an invalid or missing origin", () => {
  for (const [value, message] of [
    [undefined, "NEXT_PUBLIC_DIRECTORY_URL is required"],
    ["http://localhost:3400", "NEXT_PUBLIC_DIRECTORY_URL must use HTTPS"],
    ["https://directory.local", "NEXT_PUBLIC_DIRECTORY_URL must be a public host"],
    ["https://directory.ci.example", "NEXT_PUBLIC_DIRECTORY_URL must be a public host"],
  ]) {
    const result = runCli(value);
    assert.equal(result.status, 1, `${value}: ${result.stderr}`);
    assert.match(result.stderr, new RegExp(`^\\[deployment config\\] ${message}`), String(value));
    assert.equal(result.stdout, "", String(value));
  }
  const flagged = runCli("https://directory.test", { args: ["--allow-documentation-names"] });
  assert.equal(flagged.status, 1, flagged.stderr);
  // Only the exact flag relaxes the check; any other argument leaves it strict.
  for (const args of [["--allow-documentation-name"], ["--verbose"], ["allow-documentation-names"]]) {
    const result = runCli("https://directory.ci.example", { args });
    assert.equal(result.status, 1, `${args}: ${result.stderr}`);
    assert.match(result.stderr, /^\[deployment config\] NEXT_PUBLIC_DIRECTORY_URL must be a public host/, String(args));
  }
});

test("the CLI exits zero and reports a valid origin", () => {
  const strict = runCli("https://directory.dacs.dev");
  assert.equal(strict.status, 0, strict.stderr);
  assert.equal(strict.stdout, "Production directory origin valid: https://directory.dacs.dev\n");
  assert.equal(strict.stderr, "");

  const ci = runCli("https://directory.ci.example", { args: ["--allow-documentation-names"] });
  assert.equal(ci.status, 0, ci.stderr);
  assert.equal(
    ci.stdout,
    "Directory origin valid (documentation names allowed; not a production check): https://directory.ci.example\n",
  );
});

test("the CLI still runs when invoked through a symlink", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "directory-origin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const link = join(dir, "check-directory-origin.mjs");
  symlinkSync(script, link);
  const result = runCli("http://localhost:3400", { path: link });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /^\[deployment config\] NEXT_PUBLIC_DIRECTORY_URL must use HTTPS/);
});

test("importing the module does not run the CLI", () => {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(pathToFileURL(script).href)});`],
    { env: childEnv("http://localhost:3400"), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout + result.stderr, "");
});

// argv[1] names a script that doesn't exist, so realpathSync throws while the
// module is preloaded; the guard must treat that as "not invoked directly".
test("preloading the module before a missing entry script does not run the CLI", () => {
  const missing = join(tmpdir(), "directory-origin-missing", "entry.mjs");
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(script).href, missing],
    { env: childEnv("http://localhost:3400"), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot find module|ERR_MODULE_NOT_FOUND/);
  assert.doesNotMatch(result.stdout + result.stderr, /\[deployment config\]/);
});

test("the CLI checks ignore runtime warnings from the inherited environment", () => {
  const warning = { NODE_OPTIONS: "--import=data:text/javascript,process.emitWarning(%22inherited%22)" };
  // The injected setting does print a warning when nothing silences it.
  const controlEnv = { ...process.env, ...warning };
  delete controlEnv.NODE_NO_WARNINGS;
  const control = spawnSync(process.execPath, ["-e", ""], { env: controlEnv, encoding: "utf8" });
  assert.match(control.stderr, /Warning: inherited/);

  const valid = runCli("https://directory.dacs.dev", { env: warning });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, "Production directory origin valid: https://directory.dacs.dev\n");
  assert.equal(valid.stderr, "");
  const invalid = runCli("http://localhost:3400", { env: warning });
  assert.equal(invalid.status, 1, invalid.stderr);
  assert.match(invalid.stderr, /^\[deployment config\] NEXT_PUBLIC_DIRECTORY_URL must use HTTPS/);
});
