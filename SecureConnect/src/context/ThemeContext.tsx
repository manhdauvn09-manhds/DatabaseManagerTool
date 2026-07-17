"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";

type Theme = "light" | "dark";

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

/**
 * ThemeProvider ALWAYS renders the Provider (never returns bare `children`).
 * Returning a different element type between the first and post-mount render
 * makes React remount the whole App Router tree on hydration — that was the
 * cause of the earlier white-screen crash. Instead we keep the tree stable and
 * only update the theme value after mount.
 *
 * The initial data-theme attribute is set by an inline <head> script (see
 * layout.tsx) BEFORE hydration, so there is no flash of the wrong theme and no
 * hydration mismatch.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");

  // Sync state with whatever the anti-FOUC script already applied to <html>.
  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    if (current === "dark" || current === "light") {
      setTheme(current);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => {
      const next = prev === "light" ? "dark" : "light";
      try {
        localStorage.setItem("theme", next);
      } catch {
        /* private mode / storage disabled — ignore */
      }
      document.documentElement.setAttribute("data-theme", next);
      return next;
    });
  }, []);

  return <ThemeContext.Provider value={{ theme, toggleTheme }}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}
