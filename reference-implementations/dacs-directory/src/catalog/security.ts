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
  const client = rateLimitClientKey(req);
  // Without an explicitly trusted proxy there is no trustworthy client IP in
  // the Web Request API. A shared fallback bucket would let one caller deny
  // service to everyone, so direct deployments rely on the documented edge
  // limiter plus the hard registry/input caps instead.
  if (!client) return null;
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
  if (bucket.count <= limit) return null;
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

export function rejectOversizeRequest(
  req: NextRequest,
  maxBytes = 64 * 1024,
): NextResponse | null {
  const raw = req.headers.get("content-length");
  if (raw && Number(raw) > maxBytes) {
    return NextResponse.json({ error: "request body too large" }, { status: 413 });
  }
  return null;
}
