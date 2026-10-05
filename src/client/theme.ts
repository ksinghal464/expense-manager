// Theme preference: 'auto' follows the system setting; 'light'/'dark' override it.
// index.html applies the stored choice before first paint (keep THEME_KEY and the
// resolution logic there in sync with this file).

export type ThemePref = 'auto' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'em_theme';
export const THEME_COLORS: Record<Theme, string> = { light: '#f5f7fa', dark: '#0d1219' };

const ORDER: ThemePref[] = ['auto', 'light', 'dark'];

export function parsePref(v: string | null | undefined): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'auto';
}

export function nextPref(p: ThemePref): ThemePref {
  return ORDER[(ORDER.indexOf(p) + 1) % ORDER.length];
}

export function resolveTheme(p: ThemePref, systemDark: boolean): Theme {
  return p === 'auto' ? (systemDark ? 'dark' : 'light') : p;
}
