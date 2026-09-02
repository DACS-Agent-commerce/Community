"use client";

export default function VerifyError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="card" role="alert" style={{ maxWidth: 640 }}>
      <p className="eyebrow">Receipt checker unavailable</p>
      <h2>We couldn&apos;t open the checker.</h2>
      <p className="meta">{error.message || "An unexpected browser error occurred."}</p>
      <button className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
