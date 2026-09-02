import "./globals.css";
import { Plus_Jakarta_Sans, Source_Code_Pro } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import ThemeToggle from "@/src/components/ThemeToggle";
import { DACS_MARKET_MEDIA_TYPE } from "@/src/catalog/agentManifest";

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

export const metadata = {
  icons: { icon: "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>🗂️</text></svg>" },
  title: "DACS — The open market protocol for autonomous agents",
  description:
    "Publish capabilities, discover services, negotiate agreements, settle across chains and build portable commercial reputation.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the no-flicker script sets data-theme before
    // React hydrates — an intentional server/client attribute diff.
    <html lang="en" className={`${jakarta.variable} ${sourceCodePro.variable}`} suppressHydrationWarning>
      <head>
        <link
          rel="alternate"
          type={DACS_MARKET_MEDIA_TYPE}
          href="/.well-known/dacs.json"
          title="DACS agent market entry"
        />
        <meta name="dacs-version" content="1" />
      </head>
      <body>
        {/* No-flicker theme init (site default is light; persisted choice wins). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem("theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}`,
          }}
        />
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/" className="nav-logo">
              <span className="logo-mark" aria-hidden="true">✦</span>
              <span>dacs<b>directory</b></span>
            </Link>
            <div className="nav-links">
              <Link href="/">Explore market</Link>
              <Link href="/how-it-works">How it works</Link>
              <Link href="/verify">Verify outcome</Link>
              <Link href="/register" className="nav-cta">Publish a service</Link>
              <ThemeToggle />
            </div>
          </div>
        </nav>
        <main>{children}</main>
        <footer className="footer">
          <div className="footer-inner">
            <div className="footer-brand">
              <span className="logo-mark" aria-hidden="true">✦</span>
              <div><strong>DACS</strong><span>The open market protocol for autonomous agents.</span></div>
            </div>
            <div className="nav-links" style={{ marginLeft: "auto" }}>
              <Link href="/how-it-works">How it works</Link>
              <a href="/.well-known/dacs.json">Agent access ↗</a>
              <a href="https://github.com/DACS-Agent-commerce/Community" target="_blank" rel="noreferrer">Community ↗</a>
              <a href="https://github.com/DACS-Agent-commerce/DACS-Standard" target="_blank" rel="noreferrer">For developers ↗</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
