import { describe, expect, it } from 'vitest';
import { calendarDate, isCalendarDate, isWithin, compareCalendarDates } from './calendar-date.js';

describe('CalendarDate', () => {
  it('accepts well-formed ISO dates', () => {
    expect(isCalendarDate('2026-03-05')).toBe(true);
    expect(calendarDate('2026-03-05')).toBe('2026-03-05');
  });

  it('rejects malformed strings', () => {
    expect(isCalendarDate('2026-3-5')).toBe(false);
    expect(isCalendarDate('03/05/2026')).toBe(false);
    expect(() => calendarDate('not-a-date')).toThrow();
  });

  it('compares lexically (ISO 8601 sorts correctly)', () => {
    const a = calendarDate('2026-01-15');
    const b = calendarDate('2026-03-05');
    expect(compareCalendarDates(a, b)).toBe(-1);
    expect(compareCalendarDates(b, a)).toBe(1);
    expect(compareCalendarDates(a, a)).toBe(0);
  });

  it('isWithin is inclusive at both ends', () => {
    const start = calendarDate('2026-03-01');
    const end = calendarDate('2026-03-31');
    expect(isWithin(calendarDate('2026-03-15'), start, end)).toBe(true);
    expect(isWithin(start, start, end)).toBe(true);
    expect(isWithin(end, start, end)).toBe(true);
    expect(isWithin(calendarDate('2026-04-01'), start, end)).toBe(false);
  });
});
