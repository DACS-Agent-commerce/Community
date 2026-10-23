import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Submit listing pointers",
  description: "Submit discovery pointers for an existing DACS service listing.",
  alternates: { canonical: "/register" },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) { return children; }
