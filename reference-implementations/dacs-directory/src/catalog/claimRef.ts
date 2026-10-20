/**
 * DACS-1 §6.3.1 Demos agent ClaimReference — `did:demos:agent:<64hex>`.
 *
 * Per the canonical profile (DACS-Standard #296): only the leading `did`
 * scheme token is case-insensitive on read (CF-2, canonicalised to lowercase
 * before comparison); the `demos:agent:` method and the key component are
 * case-sensitive, and an uppercase key is non-canonical — a reader must
 * reject it rather than lowercase it. `demos:0x…` is substrate-address
 * notation, not a registered ClaimReference, and never resolves here.
 *
 * CORE B.1 CF-3: a reference may carry advisory `?key=value` parameters in
 * exact CF-2 form; they do not participate in identity. This mirrors the
 * SDK's `parseDemosAgentClaimReference` (`identity/demos.ts`), which this
 * module cannot import because the SDK identity tree loads `node:net` and
 * this code also runs in the browser. `test/claim-ref.test.ts` pins parity.
 */
const DEMOS_AGENT_DID = /^[dD][iI][dD]:(demos:agent:[0-9a-f]{64})(?:\?(.*))?$/s;
const RESERVED_PARAMETER_CHARACTERS = new Set([":", "?", "&", "=", "%"]);

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index] !== rightPoints[index]) return leftPoints[index]! - rightPoints[index]!;
  }
  return leftPoints.length - rightPoints.length;
}

/** CF-2 parameter segment: only the reserved set may be (upper-hex) escaped. */
function decodeParameterSegment(value: string): string | null {
  let decoded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === "%") {
      const encoded = value.slice(index + 1, index + 3);
      if (!/^[0-9A-F]{2}$/.test(encoded)) return null;
      const replacement = String.fromCharCode(Number.parseInt(encoded, 16));
      if (!RESERVED_PARAMETER_CHARACTERS.has(replacement)) return null;
      decoded += replacement;
      index += 2;
      continue;
    }
    if (RESERVED_PARAMETER_CHARACTERS.has(character)) return null;
    decoded += character;
  }
  return decoded;
}

/** CF-2 parameters: non-empty, unique keys in code-point order. */
function canonicalParameters(query: string): boolean {
  if (!query) return false;
  const keys = new Set<string>();
  let previous: string | undefined;
  for (const parameter of query.split("&")) {
    const equals = parameter.indexOf("=");
    if (equals <= 0 || equals !== parameter.lastIndexOf("=")) return false;
    const key = decodeParameterSegment(parameter.slice(0, equals));
    if (key === null || decodeParameterSegment(parameter.slice(equals + 1)) === null || keys.has(key)) {
      return false;
    }
    if (previous !== undefined && compareCodePoints(previous, key) >= 0) return false;
    keys.add(key);
    previous = key;
  }
  return true;
}

function parseDemosAgentClaim(value: string): { reference: string; identity: string } | null {
  if (value.normalize("NFC") !== value || /[\s\u0000-\u001f\u007f]/.test(value)) return null;
  const match = DEMOS_AGENT_DID.exec(value);
  if (!match || (match[2] !== undefined && !canonicalParameters(match[2]))) return null;
  const identity = `did:${match[1]}`;
  return { reference: match[2] === undefined ? identity : `${identity}?${match[2]}`, identity };
}

/**
 * Parameter-free CF-3 identity (`did:demos:agent:…`) of a Demos agent claim
 * reference, or null. Matching and key resolution use this identity.
 */
export function canonicalDemosAgentClaim(value: string): string | null {
  return parseDemosAgentClaim(value)?.identity ?? null;
}

/**
 * Exact CF-2 bytes of a Demos agent claim reference — the scheme token
 * lowercased, every advisory parameter kept — or null.
 */
export function canonicalDemosAgentReference(value: string): string | null {
  return parseDemosAgentClaim(value)?.reference ?? null;
}

/** True when the value already is the canonical, parameter-free identity. */
export function isCanonicalDemosAgentClaim(value: unknown): value is string {
  return typeof value === "string" && canonicalDemosAgentClaim(value) === value;
}
