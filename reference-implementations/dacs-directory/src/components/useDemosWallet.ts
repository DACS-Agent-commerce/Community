"use client";
/**
 * Demos wallet extension hook — production-proven handshake + parsing
 * (mirrors SuperColony's wallet-init.js/wallet.ts, battle-tested against the
 * real extension):
 *  - detection: retry `demosRequestProvider` up to 10×300ms (the extension
 *    may not be ready at mount), also honour an early-captured provider
 *  - `connect` returns the UMI envelope { success, data: { address } } —
 *    never a bare { address }
 *  - `sign` (wallet API 2026-05) takes { message, publicKey } — a bare
 *    string makes the wallet throw internally and reject
 *  - errors are surfaced, never swallowed
 */
import { useEffect, useState } from "react";

export interface DemosProvider {
  request: (req: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    __demosProviderCaptured?: DemosProvider | null;
    demos?: DemosProvider;
  }
}

type Envelope = {
  success?: boolean;
  data?: { address?: string; signature?: string; data?: string } | string;
  address?: string;
  signature?: string;
  error?: { code?: string; message?: string };
};

export function useDemosWallet() {
  const [provider, setProvider] = useState<DemosProvider | null>(null);
  const [detecting, setDetecting] = useState(true);
  const [address, setAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const found = (p: DemosProvider | null | undefined) => {
      if (alive && p) {
        setProvider(p);
        setDetecting(false);
      }
    };
    // Early capture (if a head script ran) or a prior announce.
    if (window.__demosProviderCaptured) return void found(window.__demosProviderCaptured);
    if (window.demos) return void found(window.demos);

    const onAnnounce = (e: Event) => {
      found((e as CustomEvent<{ provider?: DemosProvider }>).detail?.provider);
    };
    window.addEventListener("demosAnnounceProvider", onAnnounce);

    // The extension may not be listening yet at mount — retry the request
    // (production pattern: 10 × 300ms).
    let attempts = 0;
    const tick = () => {
      if (!alive) return;
      attempts++;
      window.dispatchEvent(new Event("demosRequestProvider"));
      if (window.__demosProviderCaptured) return void found(window.__demosProviderCaptured);
      if (attempts < 10) setTimeout(tick, 300);
      else if (alive) setDetecting(false);
    };
    tick();

    return () => {
      alive = false;
      window.removeEventListener("demosAnnounceProvider", onAnnounce);
    };
  }, []);

  const connect = async (): Promise<string | null> => {
    if (!provider) return null;
    setConnecting(true);
    setError(null);
    try {
      const res = (await provider.request({ method: "connect" })) as Envelope;
      if (res && typeof res === "object" && res.success === false) {
        throw new Error(res.error?.message || res.error?.code || "wallet rejected the connection");
      }
      // Envelope-tolerant: { data: { address } } | { data: "0x…" } | { address }.
      const raw =
        (typeof res?.data === "object" ? res.data?.address : undefined) ??
        (typeof res?.data === "string" ? res.data : undefined) ??
        res?.address;
      if (!raw) throw new Error("wallet returned no address");
      const addr = raw.startsWith("0x") ? raw : `0x${raw}`;
      setAddress(addr);
      return addr;
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setConnecting(false);
    }
  };

  const sign = async (message: string): Promise<string | null> => {
    if (!provider || !address) return null;
    setError(null);
    try {
      // 2026-05 wallet API: object param with publicKey (old wallets tolerate it too).
      const res = (await provider.request({
        method: "sign",
        params: [{ message, publicKey: address }],
      })) as Envelope | string;
      if (typeof res === "string") return res;
      if (res && res.success === false) {
        throw new Error(res.error?.message || res.error?.code || "wallet rejected signing");
      }
      const d = res?.data;
      const sig =
        (typeof d === "object" ? d?.signature ?? d?.data : undefined) ??
        (typeof d === "string" ? d : undefined) ??
        res?.signature;
      if (!sig) throw new Error("wallet returned no signature");
      return sig;
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  const send = async (tx: unknown): Promise<unknown | null> => {
    if (!provider) return null;
    setError(null);
    try {
      const res = (await provider.request({ method: "sendTransaction", params: [tx] })) as Envelope;
      if (res && typeof res === "object" && res.success === false) {
        throw new Error(res.error?.message || res.error?.code || "wallet rejected the transaction");
      }
      return res ?? {};
    } catch (e) {
      setError((e as Error).message);
      return null;
    }
  };

  return { available: !!provider, detecting, address, connecting, connect, sign, send, error };
}
