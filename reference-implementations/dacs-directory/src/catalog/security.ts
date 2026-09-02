import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { NextRequest, NextResponse } from "next/server";

const buckets = new Map<string, { count: number; resetAt: number }>();
const MAX_BUCKETS = 4096;
let requestsUntilSweep = 256;

export function rateLimitClientKey(req: NextRequest): string | null {
  const trustsProxy = process.env.DACS_TRUST_PROXY === "1" || process.env.DACS_TRUST_PROXY === "true";
  if (!trustsProxy) return null;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidate = forwarded || req.headers.get("x-real-ip")?.trim() || "";
  return isIP(candidate) ? candidate : null;
}

function pruneBuckets(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value as string | undefined;
    if (!oldest) break;
    buckets.delete(oldest);
  }
  requestsUntilSweep = 256;
}

export function resetRateLimitState(): void {
  buckets.clear();
  requestsUntilSweep = 256;
}

export const rateLimitStateSize = (): number => buckets.size;

/** Small per-process abuse brake. Deployments should also rate-limit at the edge. */
export function rateLimit(
  req: NextRequest,
  scope: string,
  limit: number,
  windowMs = 60_000,
): NextResponse | null {
  // A trusted proxy provides fair per-client buckets. Direct deployments use
  // a larger shared brake: less precise, but public expensive endpoints are
  // never left completely unlimited.
  const resolvedClient = rateLimitClientKey(req);
  const client = resolvedClient ?? "shared-direct";
  const effectiveLimit = resolvedClient ? limit : Math.max(limit * 10, 20);
  const key = `${scope}:${client}`;
  const now = Date.now();
  const prior = buckets.get(key);
  requestsUntilSweep -= 1;
  if ((!prior && buckets.size >= MAX_BUCKETS) || requestsUntilSweep <= 0) pruneBuckets(now);
  const bucket = !prior || prior.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : prior;
  bucket.count += 1;
  buckets.set(key, bucket);
  if (bucket.count <= effectiveLimit) return null;
  return NextResponse.json(
    { error: "rate limit exceeded" },
    {
      status: 429,
      headers: { "retry-after": String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))) },
    },
  );
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Protect operational endpoints. Local development remains convenient when no
 * token is configured; production fails closed if DACS_ADMIN_TOKEN is absent.
 */
export function requireAdmin(req: NextRequest): NextResponse | null {
  const expected = process.env.DACS_ADMIN_TOKEN;
  if (!expected) {
    if (process.env.NODE_ENV !== "production") return null;
    return NextResponse.json(
      { error: "administrative endpoint disabled" },
      { status: 503 },
    );
  }
  const auth = req.headers.get("authorization") ?? "";
  const actual = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return equalSecret(actual, expected)
    ? null
    : NextResponse.json({ error: "unauthorized" }, { status: 401 });
}

export type JsonBodyResult<T> =
  | { ok: true; value: T | null }
  | { ok: false; response: NextResponse };

/** Read and bound the actual body bytes; Content-Length is only an early hint. */
export async function readJsonBody<T>(
  req: NextRequest,
  maxBytes = 64 * 1024,
): Promise<JsonBodyResult<T>> {
  const declared = req.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "request body too large" }, { status: 413 }),
    };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await req.arrayBuffer();
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "could not read request body" }, { status: 400 }),
    };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      ok: false,
      response: NextResponse.json({ error: "request body too large" }, { status: 413 }),
    };
  }
  try {
    const text = new TextDecoder().decode(bytes);
    return { ok: true, value: text.length > 0 ? JSON.parse(text) as T : null };
  } catch {
    return {
      ok: false,
      response: NextResponse.json({ error: "request body must be valid JSON" }, { status: 400 }),
    };
  }
}
