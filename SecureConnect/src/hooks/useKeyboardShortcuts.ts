import { useEffect } from "react";

export interface KeyboardShortcuts {
  "ctrl+k"?: () => void;
  "ctrl+enter"?: () => void;
  "ctrl+i"?: () => void;
  "ctrl+l"?: () => void;
  "escape"?: () => void;
}

export function useKeyboardShortcuts(shortcuts: KeyboardShortcuts) {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) {
        if (e.key === "Escape") {
          shortcuts.escape?.();
        }
        return;
      }

      const key = [
        e.ctrlKey || e.metaKey ? "ctrl" : "",
        e.shiftKey ? "shift" : "",
        e.key.toLowerCase() === "enter" ? "enter" : e.key.toLowerCase()
      ]
        .filter(Boolean)
        .join("+");

      switch (key) {
        case "ctrl+k":
          e.preventDefault();
          shortcuts["ctrl+k"]?.();
          break;
        case "ctrl+enter":
          e.preventDefault();
          shortcuts["ctrl+enter"]?.();
          break;
        case "ctrl+i":
          e.preventDefault();
          shortcuts["ctrl+i"]?.();
          break;
        case "ctrl+l":
          e.preventDefault();
          shortcuts["ctrl+l"]?.();
          break;
        case "escape":
          shortcuts.escape?.();
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
