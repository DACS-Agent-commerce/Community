import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { isValidElement, type ReactNode } from "react";

// The deal page shows a delivery attestation read from the seller's derived address.
// tsconfig preserves JSX for Next.js, so tsx compiles the page with the classic runtime.
(globalThis as { React?: typeof React }).React = React;
const dataDirectory = mkdtempSync(join(tmpdir(), "dacs-directory-deal-page-"));
process.env.DACS_DIRECTORY_DATA = dataDirectory;
const { default: Deal } = await import("../app/deal/[ref]/page.js");
const { resolveProgramAddress } = await import("../src/catalog/store.js");
test.after(() => rmSync(dataDirectory, { recursive: true, force: true }));

const sellerHex = "5".repeat(64);
const seller = `did:demos:agent:${sellerHex}`;
const bundleRef = `stor-${"12".repeat(20)}`;
const attestationAt = resolveProgramAddress(seller, "dacsx:delivery:job-delivered")!;
const attestation = { repo: "org/repo", pullNumber: 7, reviewId: 9, ghAuthor: "reviewer", ghStateHash: "f".repeat(64) };

/** Every text node in an unrendered element tree; components are not called. */
function texts(node: ReactNode): string[] {
  if (typeof node === "string" || typeof node === "number") return [String(node)];
  if (Array.isArray(node)) return node.flatMap(texts);
  return isValidElement<{ children?: ReactNode }>(node) ? texts(node.props.children) : [];
}

test("the deal page shows a delivery attestation only from the seller's own storage, and never claims it is signed unchecked", async () => {
  const originalFetch = globalThis.fetch;
  const render = async (attestationOwner: string) => {
    globalThis.fetch = async (input) => {
      const at = String(input).replace(/^.*\/storage-program\//, "");
      const [owner, data] = at === bundleRef ? [`0x${"1".repeat(64)}`, { jobId: "job-delivered", outcome: "completed" }]
        : at === attestationAt ? [attestationOwner, attestation] : [null, null];
      return data ? Response.json({ success: true, owner, programName: "opaque", data }) : new Response(null, { status: 404 });
    };
    return texts(await Deal({ params: Promise.resolve({ ref: bundleRef }), searchParams: Promise.resolve({ seller }) })).join("");
  };
  try {
    const owned = await render(`0x${sellerHex}`);
    assert.match(owned, /What was delivered/);
    assert.doesNotMatch(owned, /The seller signed this delivery attestation/);
    assert.match(owned, /Check its signature to confirm the seller signed it/);
    // Another writer's record at the derived address is not the seller's attestation.
    assert.doesNotMatch(await render(`0x${"6".repeat(64)}`), /What was delivered/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
