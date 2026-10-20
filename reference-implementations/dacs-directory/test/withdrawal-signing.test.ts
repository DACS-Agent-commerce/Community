import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { ed25519Sign, privateKeyFromSeed, publicKeyFromSeed, rawPublicKey } from "@kynesyslabs/dacs/crypto";
import { applyPublisherSignature, WithdrawalSigningInstructions } from "../src/components/withdrawal-signing.js";
import { requestWellKnownFiles, WellKnownFiles } from "../src/components/wellknown-files.js";
import { sha256Hex } from "../src/catalog/canonical.js";
import { crawlDomain, wellKnownWithdrawalMessage } from "../src/catalog/wellknown.js";

const { renderToStaticMarkup } = createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup: (node: ReactNode) => string;
};
const seed = new Uint8Array(32).fill(61);
const signer = `did:demos:agent:${Buffer.from(rawPublicKey(publicKeyFromSeed(seed))).toString("hex")}`;
const walletSign = (message: string, signerSeed = seed) => `0x${Buffer.from(ed25519Sign(Buffer.from(message, "utf8"), privateKeyFromSeed(signerSeed))).toString("hex")}`;

/** A generated export, as the wellknown-files route returns it. */
function generated() {
  const listingsJson = JSON.stringify({ indexVersion: "1", generatedAt: 1, seller: signer, listings: [] }, null, 2);
  const card = JSON.stringify({ name: "Seller", dacs: { dacsVersion: "1", listings: {
    indexUrl: "https://agent.example/.well-known/dacs/listings.json", indexHash: `sha256-${sha256Hex(listingsJson)}` } } }, null, 2);
  const files = { "/.well-known/agent.json": card, "/.well-known/agent-card.json": card, "/.well-known/dacs/listings.json": listingsJson };
  const signing = { algorithm: "ed25519", signer, message: wellKnownWithdrawalMessage("agent.example", sha256Hex(listingsJson)),
    signatureField: "dacs.listings.publisherSignature", encoding: "base64url" };
  return { files, signing };
}

test("publication instructions expose exact signing bytes, both card completion steps and the unsigned-refresh consequence", () => {
  const { signing } = generated();
  const rendered = renderToStaticMarkup(createElement(WithdrawalSigningInstructions, { signing }));
  for (const required of [signing.message, signer, "ed25519", "base64url", "dacs.listings.publisherSignature", "agent.json", "agent-card.json",
    "listings.json", "byte-exact", "hosting an unsigned one withholds every listing"]) {
    assert.ok(rendered.includes(required), `missing publication instruction: ${required}`);
  }
});

test("a wallet signature is converted, verified and placed in both cards, and the crawler then authenticates the index", async () => {
  const { files, signing } = generated();
  const signed = await applyPublisherSignature(files, signing, walletSign(signing.message));
  const value = JSON.parse(signed["/.well-known/agent.json"]).dacs.listings.publisherSignature;
  assert.match(value, /^[A-Za-z0-9_-]{86}$/);
  assert.equal(signed["/.well-known/agent-card.json"], signed["/.well-known/agent.json"]);
  assert.equal(signed["/.well-known/dacs/listings.json"], files["/.well-known/dacs/listings.json"], "listings.json stays byte-exact");
  const crawl = async (hosted: Record<string, string>) => {
    const agent = await crawlDomain("agent.example", { validateUrl: async () => ({} as never), fetchJson: async (url: string) => {
      const raw = hosted[new URL(url).pathname]; return raw ? { raw, body: JSON.parse(raw) } : null;
    } });
    assert.ok(!("error" in agent)); return agent.withdrawalAuthenticated;
  };
  assert.equal(await crawl(signed), true);
  // The hex the wallet returns is not a publisher signature: hosted as-is, the index would read as unsigned.
  const pasted = JSON.parse(files["/.well-known/agent.json"]); pasted.dacs.listings.publisherSignature = walletSign(signing.message);
  assert.equal(await crawl({ ...files, "/.well-known/agent.json": JSON.stringify(pasted) }), false, "positive control");
});

test("a wallet signature that does not verify for this seller and message is refused", async () => {
  const { files, signing } = generated();
  for (const [signature, error] of [[walletSign(signing.message, new Uint8Array(32).fill(62)), /does not verify/],
    [walletSign(`${signing.message}\n`), /does not verify/], ["0x1234", /64-byte/], [`${walletSign(signing.message)}00`, /64-byte/],
    [Buffer.from(ed25519Sign(Buffer.from(signing.message), privateKeyFromSeed(seed))).toString("base64url"), /64-byte/]] as const) {
    await assert.rejects(applyPublisherSignature(files, signing, signature), error);
  }
});

test("the register page's request never throws and surfaces every failure as an error", async () => {
  const request = { claim: signer, domain: " agent.example ", a2aEndpoint: " https://agent.example/a2a ", a2aTransport: "HTTP+JSON" };
  const asked: string[] = [];
  const answer = (response: () => Response) => async (input: string | URL | Request) => { asked.push(String(input)); return response(); };
  for (const [fetchImpl, error] of [
    [async () => { throw new TypeError("fetch failed"); }, /could not be reached/],
    [answer(() => new Response("", { status: 500 })), /HTTP 500/],
    [answer(() => new Response("<html>Bad gateway</html>", { status: 502 })), /HTTP 502/],
    [answer(() => Response.json({ error: "submit a public HTTPS hostname" }, { status: 400 })), /public HTTPS hostname/],
    [answer(() => Response.json({ files: {} })), /HTTP 200/],
  ] as const) {
    const result = await requestWellKnownFiles(request, fetchImpl as typeof fetch);
    assert.ok("error" in result);
    assert.match(result.error, error);
  }
  const query = new URL(asked[0], "https://directory.example").searchParams;
  assert.deepEqual([...query], [["claim", signer], ["domain", "agent.example"], ["a2aEndpoint", "https://agent.example/a2a"], ["a2aTransport", "HTTP+JSON"]]);
});

test("the register page asks for the A2A endpoint and offers every pinned transport", () => {
  const rendered = renderToStaticMarkup(createElement(WellKnownFiles, { claim: signer, sign: async () => null }));
  assert.match(rendered, /<input id="a2a-endpoint"[^>]*type="url"/);
  for (const transport of ["JSONRPC", "GRPC", "HTTP+JSON"]) assert.ok(rendered.includes(`<option value="${transport}"`), transport);
  assert.match(rendered, /<button[^>]*disabled=""[^>]*>Generate \.well-known files<\/button>/, "nothing to generate until domain and endpoint are filled");
});
