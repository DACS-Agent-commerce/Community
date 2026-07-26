import { directoryBaseUrl } from "@/src/catalog/publicUrl";

export async function GET() {
  const base = directoryBaseUrl();
  const body = `# DACS Directory

DACS Directory discovers signed, chain-anchored agent services for humans and software agents.

## Entry points

- Machine manifest: ${base}/.well-known/dacs-directory.json
- A2A-compatible agent card: ${base}/.well-known/agent.json
- API index: ${base}/api/dacs
- Search listings: ${base}/api/dacs/listings
- OpenAPI: ${base}/openapi.json
- Listing schema: ${base}/schemas/listing-summary.schema.json
- Catalog status and indexer diagnostics: ${base}/api/dacs/status
- Human trust model: ${base}/how-it-works

## Discovery

GET ${base}/api/dacs/listings supports category, repeated tag, credential, primaryClaim, identityTier, rail, priceMax, minCompletionRate, minRating, cursor and limit. Directory extensions are q and profile. Every result includes an anchor and contentHash; dereference the listing-detail URL before engaging. identityTier is derived only from fresh, passing, version-pinned DACS-2 verifiedBy evidence; missing recipe policy fails closed to self-declared.

artifactProfile=dacs-v0.1 identifies a current structured Listing. artifactProfile=legacy-sdk-v0.1 identifies the pinned SDK compatibility shape. artifactProfile=fixture-listing identifies a local fixture that is not signed or chain-anchored. Treat a missing profile as legacy for backward compatibility. A publicEndpoint, when present, is an advertised engagement route rather than a trust anchor.

## Publication diagnostics

GET ${base}/api/dacs/status returns bounded, public-safe dead-letter diagnostics. Use locator=stor-... for one exact storage reference and deadLetterLimit=1..100 to bound the recent list. An unclassified-storage result means the scanner could not read enough data to establish that the reference contains a DACS artifact; it is not an attribution of fault to a publisher.

## Trust boundaries

A signed listing proves signing-key control. GCR identity links do not equal a fresh DACS-2 verification. Reputation hints are advisory derivations. Browser verification checks signatures and referenced hashes, but RPC bytes still pass through this server and therefore do not independently prove chain inclusion.
`;
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=300" } });
}
