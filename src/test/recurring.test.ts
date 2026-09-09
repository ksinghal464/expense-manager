import { describe, it, expect } from 'vitest';
import { advanceDue } from '../worker/recurring';

describe('advanceDue', () => {
  it('advances daily by N days', () => {
    expect(advanceDue('2026-01-01T00:00:00.000Z', 'daily', 3)).toBe(
      new Date('2026-01-04T00:00:00.000Z').toISOString()
    );
  });
  it('advances weekly by N weeks', () => {
    expect(advanceDue('2026-01-01T00:00:00.000Z', 'weekly', 2)).toBe(
      new Date('2026-01-15T00:00:00.000Z').toISOString()
    );
  });
  it('advances monthly across a year boundary', () => {
    expect(advanceDue('2026-12-15T00:00:00.000Z', 'monthly', 2)).toBe(
      new Date('2027-02-15T00:00:00.000Z').toISOString()
    );
  });
  it('advances yearly', () => {
    expect(advanceDue('2026-02-28T00:00:00.000Z', 'yearly', 1)).toBe(
      new Date('2027-02-28T00:00:00.000Z').toISOString()
    );
  });
  it('throws on an invalid due date', () => {
    expect(() => advanceDue('not-a-date', 'daily', 1)).toThrow();
  });
});
