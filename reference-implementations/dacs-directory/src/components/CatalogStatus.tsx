"use client";
/**
 * Catalog-freshness chip — how far the catalog (a cache, §6.3.6) trails the
 * chain. Reindexing is an authenticated operational action, never a public UI
 * side effect. Green when the cursor is at the tip, amber when it trails.
 */
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Status {
  generatedAt: number;
  syncedToTx: number;
  chainLatestTx: number | null;
  txsBehind: number | null;
  indexerRunning: boolean;
  indexing: boolean;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  lastError: string | null;
}

function ago(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function CatalogStatus() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const catalogRevision = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    let loading = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (!active || loading) return;
      if (document.visibilityState === "hidden") {
        timer = setTimeout(load, 30_000);
        return;
      }
      loading = true;
      try {
        const response = await fetch("/api/dacs/status", { cache: "no-store" });
        if (!response.ok) throw new Error("status unavailable");
        const next = await response.json() as Status;
        if (!active) return;
        const previous = catalogRevision.current;
        catalogRevision.current = next.generatedAt;
        setStatus(next);
        if (previous !== null && next.generatedAt > previous) router.refresh();
      } catch {
        /* Preserve the last useful status through a transient node failure. */
      } finally {
        loading = false;
        if (active) timer = setTimeout(load, 3_000);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (timer) clearTimeout(timer);
      void load();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  if (!status || status.generatedAt === 0) return null;

  const behind = status.txsBehind;
  const inSync = behind !== null && behind === 0;
  const cls = !status.indexerRunning
    ? "err"
    : status.indexing || (behind !== null && behind > 0)
      ? "warn"
      : inSync
        ? "ok"
        : "";
  const label = !status.indexerRunning
    ? "Live indexer offline"
    : status.indexing
      ? "Indexing new activity"
      : behind !== null && behind > 0
        ? "New activity detected"
        : inSync
          ? "Listening for activity"
          : "Listings recently updated";

  return (
    <span
      className={`sync-chip ${cls}`}
      title={`${label}. Last catalog update ${new Date(status.generatedAt).toLocaleString()}${
        status.lastError ? `. Last indexer error: ${status.lastError}` : "."
      }`}
    >
      <span className={`sync-dot ${status.indexing ? "pulse" : ""}`} />
      {label} · {ago(status.generatedAt)}
    </span>
  );
}
