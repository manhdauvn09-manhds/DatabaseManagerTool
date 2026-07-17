"use client";

import { useTheme } from "@/context/ThemeContext";

/**
 * Small light/dark toggle button. Safe to render anywhere under ThemeProvider.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? "Chuyển sang giao diện sáng" : "Chuyển sang giao diện tối"}
      title={isDark ? "Light mode" : "Dark mode"}
      className={`text-sm px-3 py-2 rounded-xl border bg-[var(--bg-secondary)] hover:opacity-80 transition ${className}`}
    >
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}
