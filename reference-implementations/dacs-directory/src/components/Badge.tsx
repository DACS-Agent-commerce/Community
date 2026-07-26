/**
 * Identity chips — self-describing and categorised. Every chip names its
 * platform, shows verification state, and links somewhere meaningful:
 * web2 → the profile (with a separate tiny "proof" link where available),
 * wallets → their block explorer.
 */
import type { CciBadge } from "@/src/catalog/types";

const PLATFORM_LABELS: Record<string, string> = {
  github: "GitHub",
  discord: "Discord",
  twitter: "X",
  telegram: "Telegram",
  evm: "EVM",
  solana: "Solana",
  mvx: "MultiversX",
  near: "NEAR",
  ton: "TON",
  xrpl: "XRPL",
  btc: "BTC",
};

const shortAddr = (a: string) =>
  a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export function CciChip({ badge, withProof = false }: { badge: CciBadge; withProof?: boolean }) {
  const platform = PLATFORM_LABELS[badge.platform] ?? badge.platform;
  if (badge.kind === "web2") {
    const handle = badge.handle.length > 22 ? badge.handle.slice(0, 20) + "…" : badge.handle;
    const profile = badge.linkUrl ?? badge.proofUrl;
    return (
      <span className="badge cci" title={`Verified ${platform} identity (on-chain CCI proof)`}>
        <b>{platform}</b>
        {profile ? (
          <a href={profile} target="_blank" rel="noreferrer" className="chip-link">{handle} ✓</a>
        ) : (
          <>{handle} ✓</>
        )}
        {withProof && badge.proofUrl && (
          <a href={badge.proofUrl} target="_blank" rel="noreferrer" className="chip-proof"
             title="View the on-chain ownership proof">proof↗</a>
        )}
      </span>
    );
  }
  return (
    <span className="badge wallet" title={`Linked ${platform} wallet: ${badge.handle}`}>
      <b>{platform}</b>
      {badge.linkUrl ? (
        <a href={badge.linkUrl} target="_blank" rel="noreferrer" className="chip-link mono">{shortAddr(badge.handle)} ↗</a>
      ) : (
        <span className="mono">{shortAddr(badge.handle)}</span>
      )}
    </span>
  );
}

/** A labelled chip group — the categorisation wrapper. */
export function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="chip-group">
      <span className="chip-group-label">{label}</span>
      <span className="badges" style={{ margin: 0 }}>{children}</span>
    </div>
  );
}
