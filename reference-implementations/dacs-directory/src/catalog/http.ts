import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { exceedsClaimBound, MAX_CLAIM_QUERY_BYTES } from "./discovery.js";

type CatalogJsonOptions = {
  links?: Array<{ href: string; rel: string; type?: string }>;
  lastModified?: number;
  cacheControl?: string;
  status?: number;
};

export function catalogJson(req: NextRequest, body: unknown, options: CatalogJsonOptions = {}): Response {
  const payload = JSON.stringify(body);
  const etag = `"${createHash("sha256").update(payload).digest("base64url")}"`;
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": options.cacheControl ?? "public, max-age=30, stale-while-revalidate=300",
    etag,
    vary: "Accept, Accept-Encoding",
  });
  if (options.lastModified) headers.set("last-modified", new Date(options.lastModified).toUTCString());
  if (options.links?.length) {
    headers.set("link", options.links.map((link) =>
      `<${link.href}>; rel="${link.rel}"${link.type ? `; type="${link.type}"` : ""}`,
    ).join(", "));
  }
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(payload, { status: options.status ?? 200, headers });
}

/**
 * Bound a ClaimReference parameter before any trimming or parsing. Returns the
 * raw value (null when absent), or a 400 response when its untrimmed UTF-8
 * size exceeds MAX_CLAIM_QUERY_BYTES.
 */
export function claimQuery<T extends string | null>(raw: T, name: string): { value: T } | { refused: Response } {
  if (raw !== null && exceedsClaimBound(raw)) {
    return { refused: NextResponse.json({ error: `${name} exceeds ${MAX_CLAIM_QUERY_BYTES} bytes` }, { status: 400 }) };
  }
  return { value: raw };
}
