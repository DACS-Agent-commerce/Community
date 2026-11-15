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

/** Bound received bytes and total read time even when Content-Length is absent or false. */
export async function readRequestJson(
  req: NextRequest,
  maxBytes = 64 * 1024,
  timeoutMs = 15_000,
): Promise<{ ok: true; value: unknown } | { ok: false; response: NextResponse }> {
  const oversized = rejectOversizeRequest(req, maxBytes);
  if (oversized) {
    void req.body?.cancel().catch(() => {});
    return { ok: false, response: oversized };
  }
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, value: null };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new Error("request body timed out")); }, timeoutMs);
  });
  const cancel = () => { void reader.cancel().catch(() => {}); };
  try {
    for (;;) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        cancel();
        return { ok: false, response: NextResponse.json({ error: "request body too large" }, { status: 413 }) };
      }
      chunks.push(chunk.value);
    }
    // Decode the bounded bytes with the native Body JSON algorithm, just as
    // Request.json() did (including this runtime's UTF-8 and BOM handling).
    try { return { ok: true, value: await new Response(Buffer.concat(chunks, bytes)).json() }; }
    catch { return { ok: true, value: null }; }
  } catch {
    cancel();
    return { ok: false, response: NextResponse.json(
      { error: timedOut ? "request body timed out" : "request body read failed" },
      { status: timedOut ? 408 : 400 },
    ) };
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}
