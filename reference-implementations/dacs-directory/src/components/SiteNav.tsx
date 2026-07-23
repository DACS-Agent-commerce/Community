"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import ThemeToggle from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "home" },
  { href: "/discover", label: "discover" },
  { href: "/try-chat", label: "watch a deal" },
  { href: "/try", label: "try dacs", featured: true },
  { href: "/how-it-works", label: "how it works" },
  { href: "/verify", label: "verify" },
  { href: "/register", label: "list your service" },
  { href: "/api/dacs", label: "developer api" },
];

export default function SiteNav() {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    if (open) menuRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        toggleRef.current?.focus();
      }
      if (event.key !== "Tab" || !open || !menuRef.current) return;
      const focusable = [...menuRef.current.querySelectorAll<HTMLElement>("a, button:not([disabled])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <nav className="nav" aria-label="Primary navigation">
      <div className="nav-inner">
        <Link href="/" className="nav-logo" onClick={() => setOpen(false)}>
          dacs<b>directory</b>
        </Link>
        <button
          ref={toggleRef}
          type="button"
          className="nav-menu-button"
          aria-expanded={open}
          aria-controls="site-navigation"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden>{open ? "×" : "☰"}</span>
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        </button>
        <div ref={menuRef} id="site-navigation" className={`nav-links ${open ? "open" : ""}`}>
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={link.featured ? "nav-try" : undefined}
              onClick={() => setOpen(false)}
            >
              {link.label}{link.featured ? <span aria-hidden> →</span> : null}
            </Link>
          ))}
          <a href="https://github.com/DACS-Agent-commerce/DACS-Standard" target="_blank" rel="noreferrer">
            standard <span aria-hidden>↗</span>
          </a>
          <ThemeToggle />
        </div>
      </div>
    </nav>
  );
}
