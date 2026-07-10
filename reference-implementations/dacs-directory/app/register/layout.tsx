import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "List your service",
  description: "Create, preview, sign, and anchor a verifiable DACS service listing.",
  alternates: { canonical: "/register" },
};

export default function RegisterLayout({ children }: { children: React.ReactNode }) { return children; }
