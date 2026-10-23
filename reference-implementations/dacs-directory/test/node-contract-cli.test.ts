import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { logicalToStorageProgramName, paymentEvidenceAddress } from "@kynesyslabs/dacs/canonical";

test("node contract CLI reserves exit zero for an observed requested SDK anchor", () => {
  const logicalAddress = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 2);
  const otherAddress = paymentEvidenceAddress("01J8ME0SXKQ4T9V2RC5HJ6WX7D", "demos-native:DEM", 3);
  const programName = logicalToStorageProgramName(logicalAddress);
  const directory = mkdtempSync(join(tmpdir(), "dacs-node-probe-cli-"));
  const preload = join(directory, "node-replies.mjs");
  // Exercise the real command without a live node. Any unmocked URL fails;
  // each child gets fresh responses and forwards its actual command arguments.
  writeFileSync(preload, `
    const programName = ${JSON.stringify(programName)};
    const logicalAddress = ${JSON.stringify(logicalAddress)};
    const storageAddress = "stor-" + "1".repeat(40);
    globalThis.fetch = async (input, init) => {
      if (!String(input).startsWith("https://node.example/")) throw new Error("unexpected node URL");
      if (!init?.signal) throw new Error("missing deadline");
      if (init?.method === "POST") {
        const request = JSON.parse(String(init.body));
        if (request.params[0].message === "getNetworkInfo") {
          return Response.json({ result: 200, response: { nodeVersion: { commit: "12".repeat(20), dirty: false } } });
        }
        return Response.json({ result: 200, response: [{ storageAddress, programName }] });
      }
      if (String(input).endsWith("stor-" + "0".repeat(40))) {
        return Response.json({ success: false, errorCode: "NOT_FOUND" }, { status: 404 });
      }
      if (!String(input).endsWith(storageAddress)) throw new Error("unexpected storage address");
      return Response.json({ success: true, programName, metadata: { logicalAddress },
        owner: "0x" + "34".repeat(32), data: { observed: true } });
    };
  `);
  try {
    for (const [args, status, scope, matches, ok] of [
      [[programName], 2, "generic-read", null, true],
      [[programName, logicalAddress], 0, "sdk-anchor", true, true],
      [[programName, otherAddress], 1, "sdk-anchor", false, false],
    ] as const) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload,
        "scripts/check-node-contract.ts", ...args], {
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        env: { ...process.env, DEMOS_RPC: "https://node.example/" }, encoding: "utf8", timeout: 15_000,
      });
      assert.ifError(result.error);
      assert.equal(result.status, status, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.equal(report.scope, scope);
      assert.equal(report.storageMetadata, true);
      assert.equal(report.anchorMetadataMatches, matches);
      assert.equal(report.ok, ok);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
