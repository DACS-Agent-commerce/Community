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
  const project = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(project);
    if (value === null || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    const proofUrl = httpUrl(row.proofUrl) ?? httpUrl(row.proof);
    return Object.fromEntries([
      ...Object.entries(row).filter(([key]) => !["proofUrl", "proof", "proofHash", "signature"].includes(key))
        .map(([key, child]) => [key, project(child)]),
      ...(proofUrl ? [["proofUrl", proofUrl]] : []),
    ]);
  };
  return new Map(parseCciRecord(primaryClaim, project(raw)).web2
    .flatMap((claim) => claim.proof ? [[claim.ref, claim.proof] as const] : []));
}
