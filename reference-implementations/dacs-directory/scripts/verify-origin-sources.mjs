import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Opt-in and needs network: `npm run verify:origin-sources`. Fetches every pinned
// copy that test/fixtures/origin-policy-sources.json cites, checks its sha256,
// re-extracts the cited rows, and compares them with the fixture. The unit tests
// check the module against the fixture offline; this checks the fixture against
// upstream. Node's fetch ignores HTTPS_PROXY: behind a proxy, run
// `node --use-env-proxy scripts/verify-origin-sources.mjs`.

// One registry row per array entry of Wireshark's generated epan/iana-info.c:
// family, network/mask, name, then the source, destination, forwardable,
// globally reachable and reserved-by-protocol flags. The generator leaves out
// rows with a termination date and writes an N/A Globally Reachable as false.
export function wiresharkRows(text) {
  const rows = [];
  const v4 = /\{ 4, \{ \.ipv4 = \{ 0x([0-9a-f]{8}), 0x([0-9a-f]{8}) \} \}, "([^"]+)", (\w+), (\w+), (\w+), (\w+), (\w+) \}/g;
  for (const [, address, mask, name, , , , global] of text.matchAll(v4)) {
    const value = Number.parseInt(address, 16);
    const prefix = Number.parseInt(mask, 16).toString(2).replace(/0+$/, "").length;
    const network = [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
    rows.push([network, prefix, global === "true", name]);
  }
  const v6 = /\{ 6, \{ \.ipv6 = \{ \{ \{ ((?:0x[0-9a-f]{2}, ){15}0x[0-9a-f]{2}) \} \}, (\d+) \} \},\s+"([^"]+)", (\w+), (\w+), (\w+), (\w+), (\w+) \}/g;
  for (const [, bytes, prefix, name, , , , global] of text.matchAll(v6)) {
    const octets = bytes.split(", ").map((byte) => Number.parseInt(byte, 16));
    const groups = [];
    for (let i = 0; i < 16; i += 2) groups.push(((octets[i] << 8) | octets[i + 1]).toString(16));
    rows.push([compressIpv6(groups), Number(prefix), global === "true", name]);
  }
  return rows;
}

function compressIpv6(groups) {
  let best = [-1, 0];
  for (let start = 0; start < 8; start += 1) {
    let end = start;
    while (end < 8 && groups[end] === "0") end += 1;
    if (end - start > best[1]) best = [start, end - start];
  }
  if (best[1] < 2) return groups.join(":");
  const head = groups.slice(0, best[0]).join(":");
  const tail = groups.slice(best[0] + best[1]).join(":");
  return `${head}::${tail}`;
}

// CPython's ipaddress tables: IPv4Network('a/b') and IPv6Network('a/b') entries.
export function cpythonRows(text) {
  return [...text.matchAll(/IPv[46]Network\('([^'/]+)\/(\d+)'\)/g)].map(([, network, prefix]) => [network, Number(prefix)]);
}

// Quoted DNS names ("name.") in Unbound's and Knot Resolver's C tables.
export function dnsNames(text) {
  return [...text.matchAll(/"([a-z0-9.-]+)\."/g)].map(([, name]) => name);
}

// Every name in IANA's Special-Use Domain Names registry XML, without the root dot
// or a "(DEPRECATED)" note.
export function ianaNames(text) {
  return [...text.matchAll(/<name>([a-z0-9.-]+)\.(?: \([A-Z]+\))?<\/name>/g)].map(([, name]) => name);
}

// The first column of the Fetch Standard's bad-port table.
export function fetchBadPorts(text) {
  return [...text.matchAll(/^ <tr><td>(\d+)<td>/gm)].map(([, port]) => Number(port));
}

function slice(text, [first, last]) {
  return text.split("\n").slice(first - 1, last).join("\n");
}

async function pinned(copy, fetchCopy) {
  const response = await fetchCopy(copy.url);
  if (!response.ok) throw new Error(`${copy.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== copy.sha256) throw new Error(`${copy.url}: sha256 ${digest}, fixture pins ${copy.sha256}`);
  return bytes.toString("utf8");
}

const key = ([network, prefix]) => `${network}/${prefix}`;

// `fetchCopy` defaults to the global fetch; the tests pass in-memory copies.
export async function verifyOriginSources(sources, { fetch: fetchCopy = fetch } = {}) {
  const failures = [];
  const expect = (ok, message) => { if (!ok) failures.push(message); };
  const copies = sources.pinnedCopies;

  const wireshark = await pinned(copies.wireshark, fetchCopy);
  for (const family of ["ipv4", "ipv6"]) {
    const upstream = wiresharkRows(slice(wireshark, copies.wireshark.lines[family]));
    expect(
      JSON.stringify(upstream) === JSON.stringify(sources[family].registryRows),
      `${family}.registryRows differ from ${copies.wireshark.url}:\n${JSON.stringify(upstream)}`,
    );
  }

  const cpython = await pinned(copies.cpython, fetchCopy);
  for (const family of ["ipv4", "ipv6"]) {
    const listed = new Set([...sources[family].notGloballyReachable, ...sources[family].globallyReachableButRejected].map(key));
    for (const row of cpythonRows(slice(cpython, copies.cpython.lines[family]))) {
      expect(listed.has(key(row)), `${family}: CPython row ${key(row)} is not in the fixture`);
    }
  }

  // The registry's names are exactly the fixture's special-use and documentation rows.
  const registry = new Set(ianaNames(slice(await pinned(copies.iana, fetchCopy), copies.iana.lines)));
  const listed = new Set([...sources.names.specialUse, ...sources.names.documentation].map(([name]) => name));
  for (const name of registry) expect(listed.has(name), `names: the IANA registry lists ${name}, which the fixture lacks`);
  for (const name of listed) expect(registry.has(name), `names: the fixture lists ${name}, which the IANA registry lacks`);

  const names = new Set(sources.names.specialUse.map(([name]) => name));
  for (const id of ["unbound", "knot"]) {
    const text = await pinned(copies[id], fetchCopy);
    for (const name of dnsNames(slice(text, copies[id].lines))) {
      expect(names.has(name), `names: ${id} lists ${name}, which the fixture lacks`);
    }
  }

  const fetchSpec = await pinned(copies.fetch, fetchCopy);
  const ports = fetchBadPorts(slice(fetchSpec, copies.fetch.lines));
  expect(JSON.stringify(ports) === JSON.stringify(sources.badPorts.ports), `badPorts differ from ${copies.fetch.url}`);
  return failures;
}

async function main() {
  const fixture = new URL("../test/fixtures/origin-policy-sources.json", import.meta.url);
  const failures = await verifyOriginSources(JSON.parse(readFileSync(fixture, "utf8")));
  for (const failure of failures) console.error(`[origin sources] ${failure}`);
  if (failures.length) process.exitCode = 1;
  else console.log("Every pinned origin-policy source matches the fixture.");
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  try {
    await main();
  } catch (error) {
    console.error(`[origin sources] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
