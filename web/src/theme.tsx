import { Moon, Sun } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

export type Theme = "light" | "dark";

/** Same key as the inline script in index.html, which applies the theme before first paint. */
const STORAGE_KEY = "inti-theme";

function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Follows the system until the user picks a theme; the pick is remembered in this browser. */
export function ThemeProvider({ children }: { children: (theme: Theme) => ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? systemTheme());
  const [chosen, setChosen] = useState(() => savedTheme() !== null);

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (chosen) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(systemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [chosen]);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Storage can be blocked; the theme still changes for this visit.
      }
      return next;
    });
    setChosen(true);
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children(theme)}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error("useTheme must be used inside ThemeProvider");
  return value;
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} onClick={toggle}>
      {theme === "dark" ? <Sun /> : <Moon />}
    </Button>
  );
}

/** The horizontal logo has black text; dark mode uses a copy with white text. */
export function logoSrc(theme: Theme): string {
  return theme === "dark" ? "/inti-logo-horizontal-dark.svg" : "/inti-logo-horizontal.svg";
}
