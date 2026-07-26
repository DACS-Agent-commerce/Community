"use client";
/** Light/dark toggle — same behaviour as the demos.network site (persisted,
 *  light-first). The no-flicker init runs inline in the layout. */
import { useEffect, useState } from "react";

export default function ThemeToggle() {
  const [theme, setTheme] = useState<string>("light");
  useEffect(() => {
    setTheme(document.documentElement.getAttribute("data-theme") ?? "light");
  }, []);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    setTheme(next);
  };
  return (
    <button className="theme-toggle" onClick={flip} aria-label="Toggle theme">
      {theme === "dark" ? "light" : "dark"}
    </button>
  );
}
