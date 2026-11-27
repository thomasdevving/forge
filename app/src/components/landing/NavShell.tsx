"use client";

import { type ReactNode, useEffect, useState } from "react";

/** Landing header: fully transparent over the hero, frosted once the hero has scrolled away. */
export function NavShell({ children, solid: always = false }: { children: ReactNode; solid?: boolean }) {
  const [scrolled, setSolid] = useState(false);
  const solid = always || scrolled;
  useEffect(() => {
    const on = () => setSolid(window.scrollY > window.innerHeight * 0.9);
    on();
    window.addEventListener("scroll", on, { passive: true });
    window.addEventListener("resize", on);
    return () => {
      window.removeEventListener("scroll", on);
      window.removeEventListener("resize", on);
    };
  }, []);
  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-[background-color,border-color,backdrop-filter] duration-300 ${
        solid ? "border-line/60 bg-bg/70 backdrop-blur-md" : "border-transparent bg-transparent backdrop-blur-none"
      }`}
    >
      {children}
    </header>
  );
}
