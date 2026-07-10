import { createHash } from "node:crypto";
import type { NextRequest } from "next/server";

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
