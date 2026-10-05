import { describe, it, expect } from 'vitest';
import { nextPref, parsePref, resolveTheme } from '../client/theme';

describe('theme', () => {
  it('parses stored values, defaulting to auto', () => {
    expect(parsePref('dark')).toBe('dark');
    expect(parsePref('light')).toBe('light');
    expect(parsePref(null)).toBe('auto');
    expect(parsePref('purple')).toBe('auto');
  });

  it('cycles auto -> light -> dark -> auto', () => {
    expect(nextPref('auto')).toBe('light');
    expect(nextPref('light')).toBe('dark');
    expect(nextPref('dark')).toBe('auto');
  });

  it('resolves auto from the system setting', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});
