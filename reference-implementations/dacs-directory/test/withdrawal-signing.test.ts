import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { WithdrawalSigningInstructions } from "../src/components/withdrawal-signing.js";
import { wellKnownWithdrawalMessage } from "../src/catalog/wellknown.js";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (node: ReactNode) => string;
};

test("publication instructions expose exact signing bytes and both card completion steps", () => {
  const signer = `did:demos:agent:${"a".repeat(64)}`;
  const message = wellKnownWithdrawalMessage("seller.example", "b".repeat(64));
  const rendered = renderToStaticMarkup(createElement(WithdrawalSigningInstructions, { signing: {
    algorithm: "ed25519", signer, message, signatureField: "dacs.listings.publisherSignature", encoding: "base64url",
  } }));
  for (const required of [message, signer, "ed25519", "base64url", "dacs.listings.publisherSignature", "agent.json", "agent-card.json", "listings.json", "byte-exact"]) {
    assert.ok(rendered.includes(required), `missing publication instruction: ${required}`);
  }
});
