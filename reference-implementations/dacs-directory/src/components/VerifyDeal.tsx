"use client";
/**
 * In-browser deal verification — the directory's thesis feature.
 *
 * The catalog's numbers are §6.3.6 hints. This component repeats strict bundle
 * signer coverage plus referenced-artifact signature/hash checks in-browser.
 * Bytes arrive through /api/dacs/artifact, so this is cryptographic consistency
 * verification rather than an independent chain-inclusion proof.
 */
import { useState } from "react";
// Side-effect: patches the browser Buffer polyfill with base64url support
// (the SDK decodes signature bytes with Buffer.from(x, "base64url")).
import "@/src/shims/buffer";
// Import ONLY pure modules: the package barrel re-exports createAgent, whose
// lazy `import("../substrate")` gets statically traced by Next's bundler and
// drags demosdk (node-only) into the client bundle. (SDK finding: a pure
// "./verify" subpath export would fix this properly — see dacs-sdk#14.)
import { ed25519Verify, publicKeyFromRaw } from "@kynesyslabs/dacs/crypto";
import {
  verifyBundleCore,
  type BundleVerification,
} from "@/vendor/dacs-sdk/dist/agent/verifyBundleCore.js";
import {
  bundleMatchesRegisteredAnchor,
  hasRequiredBundleSignatures,
  registeredAnchorRole,
  refsPassStrictPolicy,
  type ResolvedArtifact,
} from "@/src/catalog/bundlePolicy";

const keyFromDid = (did: string): Uint8Array | null => {
  const hex = did.match(/(?:^|:)(?:0x)?([0-9a-fA-F]{64})$/)?.[1];
  return hex ? Uint8Array.from(Buffer.from(hex, "hex")) : null;
};

// Mirrors the SDK's sessionAnchorName (not exported publicly — dacs-sdk#14).
const anchorName: Record<string, (jobId: string) => string> = {
  "dacs-3-agreement": (j) => `dacs3:agreement:${j}`,
  "dacs-4-evidence": (j) => `dacs4:evidence:${j}`,
  "dacs-2-verifyresult": (j) => `dacs2:verifyrecord:${j}`,
};

async function fetchArtifact(params: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`/api/dacs/artifact?${params}`);
  const json = (await res.json()) as { value: Record<string, unknown> | null };
  return json.value ?? null;
}

async function registeredBundleRefs(jobId: string): Promise<{
  owners: unknown;
  buyerBundleRef: unknown;
  sellerBundleRef: unknown;
} | null> {
  try {
    const res = await fetch(`/api/dacs/deal-owners?jobId=${encodeURIComponent(jobId)}`);
    if (!res.ok) return null;
    return await res.json() as { owners: unknown; buyerBundleRef: unknown; sellerBundleRef: unknown };
  } catch {
    return null;
  }
}

// Plain-language translations of the protocol's check names.
const REF_LABELS: Record<string, { what: string; means: string }> = {
  "dacs-3-agreement": {
    what: "The agreement",
    means: "what was promised, by whom, at what price — unchanged since it was signed",
  },
  "dacs-4-evidence": {
    what: "The payment record",
    means: "the settlement evidence, including the transaction reference — unchanged",
  },
  "dacs-2-verifyresult": {
    what: "The identity check",
    means: "the vetting that ran before any money moved — unchanged",
  },
  "dacs-1-listing": {
    what: "The original listing",
    means: "the service as it was advertised when this deal was struck — unchanged",
  },
};
const REF_FAIL: Record<string, string> = {
  missing: "can't be found on the chain",
  "invalid-shape": "isn't a valid record",
  "hash-mismatch": "has been ALTERED since the deal was signed",
  unresolved: "couldn't be located",
};

export default function VerifyDeal({
  bundleRef,
  buyerOwner,
  expectedSeller,
}: {
  bundleRef: string;
  buyerOwner: string;
  expectedSeller?: string;
}) {
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [result, setResult] = useState<BundleVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<"strict-pass" | "limited" | "fail" | null>(null);

  const run = async () => {
    setState("running"); setError(null); setResult(null); setVerdict(null);
    try {
      const resolvedArtifacts: ResolvedArtifact[] = [];
      let rawBundle: Record<string, unknown> | null = null;
      const verification = await verifyBundleCore(bundleRef, {
      readArtifact: async (r) => {
        const raw = await fetchArtifact(`ref=${encodeURIComponent(r)}`);
        if (r === bundleRef) rawBundle = raw;
        // The pinned SDK uses readArtifact only for the root and final listing;
        // agreement/evidence/vet artifacts enter through resolveRef below.
        if (raw && r !== bundleRef) resolvedArtifacts.push({ kind: "dacs-1-listing", raw });
        return raw;
      },
      resolveRef: async (kind, jobId) => {
        const name = anchorName[kind]?.(jobId);
        if (!name) return null;
        const raw = await fetchArtifact(
          `owner=${encodeURIComponent(buyerOwner)}&name=${encodeURIComponent(name)}`,
        );
        if (raw) resolvedArtifacts.push({ kind, raw });
        return raw;
      },
      resolvePublicKey: async (did) => keyFromDid(did),
      verify: async (b, s, p) => ed25519Verify(b, s, publicKeyFromRaw(p)),
      });
      const buyer = verification.bundle?.parties.find((p) => p.role === "buyer")?.primaryClaim;
      const seller = verification.bundle?.parties.find((p) => p.role === "seller")?.primaryClaim;
      const registered = verification.bundle?.jobId
        ? await registeredBundleRefs(verification.bundle.jobId) : null;
      const anchorBindingAvailable = registeredAnchorRole(
        bundleRef,
        registered?.buyerBundleRef,
        registered?.sellerBundleRef,
      ) !== null;
      const owners = registered?.owners && typeof registered.owners === "object" &&
        !Array.isArray(registered.owners) ? registered.owners as Record<string, unknown> : null;
      const registeredPartiesMatch = typeof owners?.buyer === "string" && typeof owners.seller === "string" &&
        buyer === owners.buyer && seller === owners.seller;
      const expectedPartiesMatch = buyer === buyerOwner && (!expectedSeller || seller === expectedSeller) &&
        (!anchorBindingAvailable || registeredPartiesMatch);
      const anchorRoleMatches = bundleMatchesRegisteredAnchor(
        verification.bundle,
        bundleRef,
        registered?.buyerBundleRef,
        registered?.sellerBundleRef,
      );
      const signaturesOk = hasRequiredBundleSignatures(
        verification,
        rawBundle,
      );
      const refsOk = signaturesOk ? await refsPassStrictPolicy(verification, resolvedArtifacts) : false;
      const internallyConsistent = verification.ok && expectedPartiesMatch && signaturesOk && refsOk;
      const strict: BundleVerification = {
        ...verification,
        ok: internallyConsistent && anchorRoleMatches,
        reason: !expectedPartiesMatch
          ? "bundle parties do not match the expected buyer/seller"
          : !signaturesOk
            ? "required buyer/seller signatures are missing or invalid"
            : !refsOk
              ? "one or more referenced artifact signatures are missing or invalid"
              : !anchorBindingAvailable
                ? "the directory has no registered address-role binding for this bundle, so anchoredByRole cannot be verified"
                : !anchorRoleMatches
                  ? "bundle anchoredByRole does not match its registered buyer/seller address"
                  : verification.reason,
      };
      setResult(strict);
      setVerdict(strict.ok ? "strict-pass" : internallyConsistent && !anchorBindingAvailable ? "limited" : "fail");
      setState("done");
    } catch (cause) {
      const message = cause instanceof TypeError
        ? "The chain records could not be reached. Check the network and try again."
        : (cause as Error).message || "The artifact version is unsupported or malformed.";
      setError(message); setState("error");
    }
  };

  return (
    <div aria-live="polite">
      <button className="btn" onClick={run} disabled={state === "running"}>
        {state === "running" ? "Verifying in your browser…" : "Verify this deal in your browser"}
      </button>
      {state === "running" && (
        <ul className="progress-list" aria-label="Verification progress">
          <li className="complete"><span aria-hidden>✓</span>Load the anchored bundle</li>
          <li className="current"><span aria-hidden>●</span>Check signatures and referenced hashes</li>
          <li><span aria-hidden>○</span>Produce a plain-language verdict</li>
        </ul>
      )}
      {error && <div className="verification-summary err" role="alert"><h3>Could not verify</h3><p>{error}</p></div>}
      {result && (
        <>
          <div className={`verification-summary ${result.ok ? "ok" : verdict === "limited" ? "limited" : "err"}`}>
            <h3>{result.ok
              ? "✓ Evidence is strictly verified"
              : verdict === "limited"
                ? "◇ Evidence is internally consistent; copy role unverified"
                : "✗ Evidence failed verification"}</h3>
            <p>{result.ok
              ? "The required parties signed, the copy role matches its registered address, and every referenced record matches its bundle hash."
              : verdict === "limited"
                ? "Signatures and referenced hashes are consistent, but this directory has no registered address-role binding for the copy."
              : result.reason ?? "One or more cryptographic checks failed."}</p>
            <p className="mono">checked {new Date().toLocaleString()}</p>
          </div>
          <ul className="trust-checks" aria-label="Plain-language verification results">
            <li><span className={result.signatures.every((signature) => signature.verdict === "valid") ? "check ok" : "check"}>{result.signatures.every((signature) => signature.verdict === "valid") ? "✓" : "✗"}</span><div><strong>Party signatures</strong><p>Buyer and seller signatures must match the keys named in the bundle.</p></div></li>
            <li><span className={result.refs.every((ref) => ref.verdict === "ok") ? "check ok" : "check"}>{result.refs.every((ref) => ref.verdict === "ok") ? "✓" : "✗"}</span><div><strong>Referenced records</strong><p>Agreement, payment, identity check, and original listing must remain unchanged.</p></div></li>
            <li><span className={result.ok ? "check ok" : "check"}>{result.ok ? "✓" : verdict === "limited" ? "?" : "✗"}</span><div><strong>Expected parties and copy address</strong><p>The buyer, seller, and unhashed anchor role must match this directory&apos;s registered copy.</p></div></li>
          </ul>
          <details className="technical-disclosure">
            <summary>Technical checks and identifiers</summary>
            <div className="table-scroll" role="region" aria-label="Detailed verification checks" tabIndex={0}>
            <table>
            <thead><tr><th>What we checked</th><th>Result</th></tr></thead>
            <tbody>
              {result.signatures.map((sig) => {
                const role = result.bundle?.parties?.find((p) => p.primaryClaim === sig.party)?.role;
                const who = role ? `The ${role}’s` : "A party’s";
                return (
                  <tr key={sig.party}>
                    <td>
                      {who} signature is {sig.verdict === "valid" ? "cryptographically valid" : "NOT valid"}
                      <div className="mono meta" style={{ marginTop: 2 }}>{sig.party}</div>
                    </td>
                    <td><span className={`badge ${sig.verdict === "valid" ? "ok" : "err"}`}>{sig.verdict === "valid" ? "genuine ✓" : sig.verdict}</span></td>
                  </tr>
                );
              })}
              {result.refs.map((r) => {
                const label = REF_LABELS[r.kind];
                const good = r.verdict === "ok";
                return (
                  <tr key={`${r.kind}/${r.id}`}>
                    <td>
                      <strong>{label?.what ?? r.kind}</strong>{" "}
                      {good ? `— ${label?.means ?? "matches the chain record"}` : `— ${REF_FAIL[r.verdict] ?? r.verdict}`}
                      <div className="mono meta" style={{ marginTop: 2 }}>{r.kind} · {r.id}</div>
                    </td>
                    <td><span className={`badge ${good ? "ok" : "err"}`}>{good ? "untampered ✓" : "problem ✗"}</span></td>
                  </tr>
                );
              })}
            </tbody>
            </table>
            </div>
          </details>
          <div className="card" style={{ marginTop: 14, background: "var(--bg-tinted)" }}>
            <h3>What this verdict does not prove</h3>
            <p className="note">
            These checks ran <em>in your browser</em>, but the records were fetched through this
            website because the Demos RPC is not browser-accessible. This proves internal
            signature/hash consistency; it does <strong>not</strong> independently prove that the
            server returned the bytes currently stored at the claimed chain addresses.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
