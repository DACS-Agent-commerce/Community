import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;

function ipv6Words(address: string): number[] | null {
  let input = address.toLowerCase().split("%", 1)[0];
  const dotted = input.match(/^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) {
    const octets = dotted[2].split(".").map(Number);
    if (octets.some((part) => part < 0 || part > 255)) return null;
    input = `${dotted[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${
      ((octets[2] << 8) | octets[3]).toString(16)
    }`;
  }
  const halves = input.split("::");
  if (halves.length > 2) return null;
  const parseHalf = (half: string) => half ? half.split(":").map((word) => Number.parseInt(word, 16)) : [];
  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if ([...left, ...right].some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) return null;
  if (halves.length === 1) return left.length === 8 ? left : null;
  const zeros = 8 - left.length - right.length;
  return zeros >= 1 ? [...left, ...Array<number>(zeros).fill(0), ...right] : null;
}

/** Conservative global-unicast policy for untrusted outbound targets. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return (
      p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && (p[1] === 0 || p[1] === 168)) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19 || (p[1] === 51 && p[2] === 100))) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113) ||
      p[0] >= 224
    );
  }
  if (isIP(address) === 6) {
    const words = ipv6Words(address);
    if (!words) return true;
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return isPrivateAddress(
        `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`,
      );
    }
    // Accept only global-unicast 2000::/3, excluding reserved/documentation
    // and transition assignments that can tunnel an unchecked IPv4 target.
    if ((words[0] & 0xe000) !== 0x2000) return true;
    if (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) return true;
    if (words[0] === 0x2001 && words[1] === 0x0db8) return true;
    if (words[0] === 0x2002) return true;
    if (words[0] === 0x3fff && (words[1] & 0xf000) === 0) return true;
    return false;
  }
  return true;
}

export class OutboundTargetError extends Error {}

export interface VettedUrl {
  url: URL;
  /** The specific resolved address the caller MUST connect to. */
  ip: string;
}

/** Resolve, reject every non-public answer, and pin one approved address. */
export async function validatePublicHttpsUrl(raw: string): Promise<VettedUrl> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new OutboundTargetError("invalid URL"); }
  if (url.href.length > 2_048 || url.protocol !== "https:" || url.username || url.password ||
      (url.port && url.port !== "443")) {
    throw new OutboundTargetError("outbound URLs must use public HTTPS on port 443");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    throw new OutboundTargetError("local hostnames are not allowed");
  }
  let resolved: Array<{ address: string; family: number }>;
  if (isIP(hostname)) {
    resolved = [{ address: hostname, family: isIP(hostname) }];
  } else {
    try { resolved = await lookup(hostname, { all: true, verbatim: true }); }
    catch (error) { throw new Error("target DNS lookup failed", { cause: error }); }
  }
  if (resolved.length === 0 || resolved.some((record) => isPrivateAddress(record.address))) {
    throw new OutboundTargetError("URL resolves to a non-public address");
  }
  if (!isIP(hostname)) url.hostname = hostname;
  return { url, ip: resolved[0].address };
}

function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new Error("whole-request timeout"));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("whole-request timeout")), remaining);
    timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function pinnedLookup(ip: string): LookupFunction {
  const family = isIP(ip) || 4;
  return function (_hostname: string, options: unknown, callback?: unknown) {
    const cb = (typeof options === "function" ? options : callback) as (
      err: NodeJS.ErrnoException | null,
      address: unknown,
      family?: number,
    ) => void;
    const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all;
    if (wantsAll) cb(null, [{ address: ip, family }], undefined);
    else cb(null, ip, family);
  } as unknown as LookupFunction;
}

export interface BoundedHttpsResponse {
  status: number;
  location: string | null;
  contentEncoding: string | null;
  body: Buffer;
  finalUrl: string;
}

interface RequestOptions {
  method?: "GET" | "HEAD";
  accept?: string;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
}

function requestPinned(url: URL, ip: string, options: Required<RequestOptions>): Promise<BoundedHttpsResponse> {
  return new Promise((resolve, reject) => {
    const signal = AbortSignal.timeout(options.timeoutMs);
    const req = httpsRequest(url, {
      agent: false,
      method: options.method,
      lookup: pinnedLookup(ip),
      servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
      signal,
      headers: {
        accept: options.accept,
        "accept-encoding": "identity",
        host: url.host,
      },
      timeout: options.timeoutMs,
    }, (res) => {
      const announced = Number(res.headers["content-length"] ?? 0);
      if (options.method !== "HEAD" && announced > options.maxBytes) {
        res.destroy(new Error("response too large"));
        return;
      }
      const encodingHeader = res.headers["content-encoding"];
      const contentEncoding = Array.isArray(encodingHeader) ? encodingHeader[0] ?? null : encodingHeader ?? null;
      // Compression is disabled so the byte cap is also the post-decoding cap.
      // A peer that ignores identity encoding is rejected rather than decoded.
      if (options.method !== "HEAD" && contentEncoding && contentEncoding.toLowerCase() !== "identity") {
        res.destroy(new Error("encoded responses are not accepted"));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) {
          res.destroy(new Error("response too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const locationHeader = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          location: Array.isArray(locationHeader) ? locationHeader[0] ?? null : locationHeader ?? null,
          contentEncoding,
          body: Buffer.concat(chunks),
          finalUrl: url.href,
        });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Credential-free bounded HTTPS request. DNS is resolved and pinned anew for
 * every hop, so redirects cannot introduce a DNS-rebinding or private target.
 */
export async function boundedPublicHttpsRequest(
  raw: string,
  options: RequestOptions = {},
): Promise<BoundedHttpsResponse> {
  const bounded: Required<RequestOptions> = {
    method: options.method ?? "GET",
    accept: options.accept ?? "application/json",
    maxBytes: Math.max(0, Math.min(1024 * 1024, options.maxBytes ?? DEFAULT_MAX_BYTES)),
    maxRedirects: Math.max(0, Math.min(5, options.maxRedirects ?? DEFAULT_MAX_REDIRECTS)),
    timeoutMs: Math.max(250, Math.min(30_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
  };
  const deadline = Date.now() + bounded.timeoutMs;
  let current = await beforeDeadline(validatePublicHttpsUrl(raw), deadline);
  for (let redirects = 0; redirects <= bounded.maxRedirects; redirects++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("whole-request timeout");
    const response = await requestPinned(current.url, current.ip, { ...bounded, timeoutMs: remaining });
    if (response.status < 300 || response.status >= 400) return response;
    if (!response.location || redirects === bounded.maxRedirects) throw new Error("redirect limit exceeded");
    current = await beforeDeadline(
      validatePublicHttpsUrl(new URL(response.location, current.url).href),
      deadline,
    );
  }
  throw new Error("redirect limit exceeded");
}
