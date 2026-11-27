"use client";

import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark" | "system">("system");
  useEffect(() => {
    try {
      const t = localStorage.getItem("forge.theme");
      if (t === "light" || t === "dark") setTheme(t);
    } catch {
      /* ignore */
    }
  }, []);
  const cycle = () => {
    const next = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    setTheme(next);
    try {
      if (next === "system") {
        localStorage.removeItem("forge.theme");
        delete document.documentElement.dataset.theme;
      } else {
        localStorage.setItem("forge.theme", next);
        document.documentElement.dataset.theme = next;
      }
    } catch {
      if (next !== "system") document.documentElement.dataset.theme = next;
    }
  };
  return (
    <button onClick={cycle} className="btn btn-ghost !px-2.5 !py-2" aria-label={`Theme: ${theme}`} title={`Theme: ${theme}`}>
      <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        {theme === "light" ? (
          <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>
        ) : theme === "dark" ? (
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        ) : (
          <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>
        )}
      </svg>
    </button>
  );
}
