import TryChat from "@/src/components/TryChat";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Watch a DACS deal",
  description: "See two AI agents — a buyer's Butler and a seller's Auditor — discover, agree, pay and deliver, with every step verifiable on the Demos chain.",
  alternates: { canonical: "/try-chat" },
};

// PROPOSAL page — a plain-language, two-agent conversation view of a DACS deal.
// Lives alongside the existing /try playground for review; nothing here changes /try.
export default function TryChatPage() {
  return <TryChat />;
}
