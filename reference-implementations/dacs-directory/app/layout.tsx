import "./globals.css";
import localFont from "next/font/local";
import Link from "next/link";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import SiteNav from "@/src/components/SiteNav";
import { directoryBaseUrl } from "@/src/catalog/publicUrl";

const jakarta = localFont({
  src: "../node_modules/@fontsource-variable/plus-jakarta-sans/files/plus-jakarta-sans-latin-wght-normal.woff2",
  variable: "--font-jakarta",
  weight: "200 800",
  style: "normal",
  display: "swap",
});
const sourceCodePro = localFont({
  src: "../node_modules/@fontsource-variable/source-code-pro/files/source-code-pro-latin-wght-normal.woff2",
  variable: "--font-scp",
  weight: "200 900",
  style: "normal",
  display: "swap",
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
              <a href="https://github.com/DACS-Agent-commerce/DACS-Standard/tree/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20" target="_blank" rel="noreferrer">standard</a>
              <a href="https://github.com/DACS-Agent-commerce/Community" target="_blank" rel="noreferrer">community</a>
              <a href="https://github.com/DACS-Agent-commerce/DACS-Standard/blob/d45c0a292006b2fd2e40d2dbe0cd7ed518ad0f20/docs/builders-guide.md" target="_blank" rel="noreferrer">builder guide</a>
              <a href="https://explorer.demos.sh" target="_blank" rel="noreferrer">explorer</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
