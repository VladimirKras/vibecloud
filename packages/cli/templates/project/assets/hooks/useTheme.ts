import { useEffect, useLayoutEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";
export interface ThemeController {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference(value: ThemePreference): void
}

export interface ThemeSnapshot {
  preference: ThemePreference
  systemTheme: ResolvedTheme
  resolved: ResolvedTheme
}

const STORAGE_KEY = "theme";
const query = "(prefers-color-scheme: dark)";

export function getInitialTheme(): ThemeSnapshot {
  const value = localStorage.getItem(STORAGE_KEY);
  const preference = value === "light" || value === "dark" || value === "system" ? value : "system";
  const systemTheme = matchMedia(query).matches ? "dark" : "light";

  return {
    preference,
    systemTheme,
    resolved: preference === "system" ? systemTheme : preference,
  };
}

export function applyDocumentTheme(theme: ResolvedTheme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

export function useTheme(initialTheme: ThemeSnapshot = getInitialTheme()): ThemeController {
  const [preference, setPreference] = useState<ThemePreference>(initialTheme.preference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(initialTheme.systemTheme);
  const resolved = preference === "system" ? systemTheme : preference;

  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setSystemTheme(media.matches ? "dark" : "light");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useLayoutEffect(() => {
    localStorage.setItem(STORAGE_KEY, preference);
    applyDocumentTheme(resolved);
  }, [preference, resolved]);

  return { preference, resolved, setPreference };
}
