import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Verify a deal",
  description: "Check DACS deal signatures and referenced-record hashes in your browser.",
  alternates: { canonical: "/verify" },
};

export default function VerifyLayout({ children }: { children: React.ReactNode }) { return children; }
