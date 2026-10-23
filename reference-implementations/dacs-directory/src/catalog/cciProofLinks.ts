import { parseCciRecord } from "@kynesyslabs/dacs/identity";

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

/** A presentation-only projection: commitments remain in the original CCI record. */
export function cciProofLinks(primaryClaim: string, raw: unknown): Map<string, string> {
  const accepted = parseCciRecord(primaryClaim, raw);
  const refs = new Set(accepted.web2.map((claim) => claim.ref));
  const links = new Map<string, string>();
  if (refs.size === 0) return links;
  const object = (value: unknown): Record<string, unknown> | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown> : undefined;
  // Locate the same identity payload selected by the SDK; unrelated nested
  // objects must not supply display links for an accepted claim.
  let payload = object(accepted.raw);
  const fields = ["xm", "web2", "ud", "pqc", "nomis", "humanpassport", "ethos", "tlsn", "linkedWallets", "linkedSocials"];
  for (let depth = 0; depth < 6 && payload; depth++) {
    const current = payload;
    if (fields.some((field) => field in current)) break;
    payload = object(payload.response) ?? object(payload.data) ?? payload;
  }
  const web2 = object(payload?.web2);
  const ambiguous = new Set<string>();
  for (const [platform, entries] of Object.entries(web2 ?? {})) {
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      const row = object(entry);
      if (!row) continue;
      const url = httpUrl(row.proofUrl) ?? httpUrl(row.proof);
      if (!url) continue;
      // Resolve each original row independently. Rewriting commitments and
      // parsing the full record again can introduce conflicts the SDK never saw.
      const claim = parseCciRecord(primaryClaim, { web2: { [platform]: [entry] } }).web2[0];
      if (!claim || !refs.has(claim.ref) || ambiguous.has(claim.ref)) continue;
      const prior = links.get(claim.ref);
      if (prior && prior !== url) {
        links.delete(claim.ref);
        ambiguous.add(claim.ref);
      } else links.set(claim.ref, url);
    }
  }
  return links;
}
