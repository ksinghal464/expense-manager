import { describe, it, expect } from 'vitest';
import { toMinor, parseAmount, formatMinor, isValidAmountMinor } from '../shared/money';

describe('money', () => {
  it('toMinor rounds to paise', () => {
    expect(toMinor(4502.24)).toBe(450224);
    expect(toMinor('12.10')).toBe(1210);
    expect(toMinor(0)).toBe(0);
    expect(toMinor('abc')).toBe(0);
  });
  it('parseAmount strips commas and currency', () => {
    expect(parseAmount('1,234.50')).toBe(123450);
    expect(parseAmount('₹999')).toBe(99900);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
  it('formatMinor formats INR', () => {
    expect(formatMinor(123450)).toContain('1,234.50');
    expect(formatMinor(0)).toBe('\u20B90.00');
    expect(formatMinor(-500)).toContain('-');
  });
  it('validates bounds', () => {
    expect(isValidAmountMinor(100)).toBe(true);
    expect(isValidAmountMinor(1.5)).toBe(false);
  });
});
