import { describe, it, expect } from 'vitest';
import { periodStart, parseDDMMYYYY, toISTDate, istDateTimeToUTC } from '../shared/period';

const at = (iso: string) => Date.parse(iso);

describe('period (IST, fixed +05:30)', () => {
  it('month start', () => {
    expect(periodStart('month', at('2026-09-08T00:00:00Z'))).toBe('2026-08-31T18:30:00.000Z');
  });
  it('year start', () => {
    expect(periodStart('year', at('2026-09-08T00:00:00Z'))).toBe('2025-12-31T18:30:00.000Z');
  });
  it('week start (Monday) for a Tuesday', () => {
    // 2026-09-08 is a Tuesday -> week starts Mon 2026-09-07 IST
    expect(periodStart('week', at('2026-09-08T00:00:00Z'))).toBe('2026-09-06T18:30:00.000Z');
  });
  it('week start keeps the current week for a Sunday', () => {
    // 2026-09-06 is a Sunday -> belongs to the week starting Mon 2026-08-31 IST
    expect(periodStart('week', at('2026-09-06T10:00:00Z'))).toBe('2026-08-30T18:30:00.000Z');
  });
});

describe('legacy date parse (dd-MM-yyyy, IST)', () => {
  it('parseDDMMYYYY to UTC', () => {
    expect(parseDDMMYYYY('20-11-2025')).toBe('2025-11-19T18:30:00.000Z');
    expect(parseDDMMYYYY('5-1-2026')).toBe('2026-01-04T18:30:00.000Z'); // 5 Jan 2026 IST
    expect(parseDDMMYYYY('bad')).toBeNull();
  });
  it('toISTDate round-trips', () => {
    expect(toISTDate('2025-11-19T18:30:00.000Z')).toBe('2025-11-20');
    expect(toISTDate('1970-01-01T00:00:00.000Z')).toBe('1970-01-01'); // 05:30 IST same day
  });
  it('istDateTimeToUTC with time', () => {
    expect(istDateTimeToUTC('2026-09-08', '09:30')).toBe('2026-09-08T04:00:00.000Z');
  });
});
