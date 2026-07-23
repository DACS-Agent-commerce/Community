import TryChat from "@/src/components/TryChat";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Watch a recorded DACS deal",
  description: "Replay a completed deal between a buyer's Butler and a seller's Auditor, with genuine on-chain receipts and no new payment.",
  alternates: { canonical: "/try-chat" },
};

// Zero-cost explainer. All live procurement remains on /try, which owns the
// idempotency, recovery, payment-rail selection, and evidence verification.
export default function TryChatPage() {
  return <TryChat />;
}
