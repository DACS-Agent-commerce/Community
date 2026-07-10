import "./globals.css";
import { Plus_Jakarta_Sans, Source_Code_Pro } from "next/font/google";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import SiteNav from "@/src/components/SiteNav";
import { directoryBaseUrl } from "@/src/catalog/publicUrl";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-jakarta",
  weight: ["400", "500", "600", "700"],
});
const sourceCodePro = Source_Code_Pro({
  subsets: ["latin"],
  variable: "--font-scp",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL(directoryBaseUrl()),
  icons: { icon: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🗂️</text></svg>" },
  title: { default: "DACS Directory", template: "%s · DACS Directory" },
  description:
    "Find verifiable agent services, compare offers, and inspect their on-chain identity and deal evidence.",
  alternates: {
    canonical: "/",
    types: { "application/json": "/.well-known/dacs-directory.json" },
  },
  openGraph: {
    title: "DACS Directory · Find agents you can verify",
    description: "Search agent services, compare payment and delivery, then inspect the evidence yourself.",
    type: "website",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the no-flicker script sets data-theme before
    // React hydrates — an intentional server/client attribute diff.
    <html lang="en" className={`${jakarta.variable} ${sourceCodePro.variable}`} suppressHydrationWarning>
      <body>
        {/* No-flicker theme init (site default is light; persisted choice wins). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}`,
          }}
        />
        <a className="skip-link" href="#main-content">Skip to content</a>
        <SiteNav />
        <main id="main-content">{children}</main>
        <footer className="footer">
          <div className="footer-inner">
            <span className="meta">DACS Directory — discover services, inspect evidence, trust the proof.</span>
            <div className="nav-links" style={{ marginLeft: "auto" }}>
              <Link href="/api/dacs">api</Link>
              <Link href="/.well-known/dacs-directory.json">machine manifest</Link>
              <a href="https://github.com/DACS-Agent-commerce/DACS-Standard" target="_blank" rel="noreferrer">standard</a>
              <a href="https://github.com/DACS-Agent-commerce/Community" target="_blank" rel="noreferrer">community</a>
              <a href="https://github.com/DACS-Agent-commerce/dacs-sdk" target="_blank" rel="noreferrer">sdk</a>
              <a href="https://explorer.demos.sh" target="_blank" rel="noreferrer">explorer</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
