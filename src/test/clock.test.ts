import { describe, it, expect } from 'vitest';
import {
  angleFromCenter,
  displayTime,
  formatTime,
  hourAngle,
  hourFromAngle,
  joinDateTime,
  minuteAngle,
  minuteFromAngle,
  parseTime,
  splitDateTime,
  to12h,
  to24h,
} from '../client/clock';

describe('clock helpers', () => {
  it('splits and joins datetime-local values', () => {
    expect(splitDateTime('2026-10-05T14:07')).toEqual({ date: '2026-10-05', time: '14:07' });
    expect(splitDateTime('2026-10-05T14:07:30')).toEqual({ date: '2026-10-05', time: '14:07' });
    expect(joinDateTime('2026-10-05', '09:30')).toBe('2026-10-05T09:30');
  });

  it('parses and formats 24h times', () => {
    expect(parseTime('14:07')).toEqual({ hour: 14, minute: 7 });
    expect(parseTime('garbage')).toEqual({ hour: 0, minute: 0 });
    expect(formatTime(9, 5)).toBe('09:05');
  });

  it('converts between 12h and 24h', () => {
    expect(to12h(0)).toEqual({ hour12: 12, meridiem: 'AM' });
    expect(to12h(12)).toEqual({ hour12: 12, meridiem: 'PM' });
    expect(to12h(23)).toEqual({ hour12: 11, meridiem: 'PM' });
    expect(to24h(12, 'AM')).toBe(0);
    expect(to24h(12, 'PM')).toBe(12);
    expect(to24h(7, 'PM')).toBe(19);
    for (let h = 0; h < 24; h++) {
      const { hour12, meridiem } = to12h(h);
      expect(to24h(hour12, meridiem)).toBe(h);
    }
    expect(displayTime('00:05')).toBe('12:05 AM');
    expect(displayTime('14:30')).toBe('2:30 PM');
  });

  it('maps pointer positions to dial angles (clockwise from 12)', () => {
    expect(angleFromCenter(0, -10)).toBeCloseTo(0); // straight up
    expect(angleFromCenter(10, 0)).toBeCloseTo(90); // right
    expect(angleFromCenter(0, 10)).toBeCloseTo(180); // down
    expect(angleFromCenter(-10, 0)).toBeCloseTo(270); // left
  });

  it('snaps angles to hours and minutes', () => {
    expect(hourFromAngle(0)).toBe(12);
    expect(hourFromAngle(90)).toBe(3);
    expect(hourFromAngle(100)).toBe(3);
    expect(hourFromAngle(350)).toBe(12);
    expect(minuteFromAngle(0)).toBe(0);
    expect(minuteFromAngle(42)).toBe(7);
    expect(minuteFromAngle(358)).toBe(0);
    expect(minuteFromAngle(42, 5)).toBe(5);
    expect(minuteFromAngle(48, 5)).toBe(10);
    expect(minuteFromAngle(357, 5)).toBe(0);
  });

  it('round-trips hour/minute through their dial angles', () => {
    for (let h = 1; h <= 12; h++) expect(hourFromAngle(hourAngle(h))).toBe(h);
    for (let m = 0; m < 60; m++) expect(minuteFromAngle(minuteAngle(m))).toBe(m);
  });
});
