"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains("dark"));
    setMounted(true);
  }, []);

  const label = mounted && isDark ? "Use light theme" : "Use dark theme";

  function toggleTheme() {
    const nextIsDark = !isDark;
    document.documentElement.classList.toggle("dark", nextIsDark);
    localStorage.setItem("sentinel-theme", nextIsDark ? "dark" : "light");
    setIsDark(nextIsDark);
  }

  return <button type="button" aria-label={label} title={label} onClick={toggleTheme} className="inline-flex h-9 w-9 items-center justify-center border border-transparent text-[#5f625d] transition-colors hover:border-[#d5d6ce] hover:bg-[#ecece5] hover:text-[#171817] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#171817] focus-visible:ring-offset-2 focus-visible:ring-offset-[#f5f5ef]">{mounted && isDark ? <Sun className="h-4 w-4" aria-hidden="true" /> : <Moon className="h-4 w-4" aria-hidden="true" />}</button>;
}
