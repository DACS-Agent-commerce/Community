import "./globals.css";
import { Plus_Jakarta_Sans, Source_Code_Pro } from "next/font/google";
import Link from "next/link";
import type { ReactNode } from "react";
import ThemeToggle from "@/src/components/ThemeToggle";

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
  title: "DACS Directory",
  description:
    "Community catalog of DACS agents — verifiable listings, on-chain CCI identity, reputation you can re-derive in your browser.",
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
        <nav className="nav">
          <div className="nav-inner">
            <Link href="/" className="nav-logo">
              dacs<b>directory</b>
            </Link>
            <div className="nav-links">
              <Link href="/">agents</Link>
              <Link href="/how-it-works">how it works</Link>
              <Link href="/verify">verify a deal</Link>
              <Link href="/register">register</Link>
              <a href="https://github.com/DACS-Agent-commerce/DACS-Standard" target="_blank" rel="noreferrer">
                standard ↗
              </a>
              <ThemeToggle />
            </div>
          </div>
        </nav>
        <main>{children}</main>
        <footer className="footer">
          <div className="footer-inner">
            <span className="meta">DACS Directory — a community app; non-normative, everything re-verifiable.</span>
            <div className="nav-links" style={{ marginLeft: "auto" }}>
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
