declare const calendarDateBrand: unique symbol;
export type CalendarDate = string & { readonly [calendarDateBrand]: never };

const ISO_DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const isCalendarDate = (s: string): s is CalendarDate => ISO_DATE.test(s);

export const calendarDate = (s: string): CalendarDate => {
  if (!isCalendarDate(s)) {
    throw new Error(`calendarDate: not an ISO 8601 YYYY-MM-DD: "${s}"`);
  }
  return s;
};

export const compareCalendarDates = (a: CalendarDate, b: CalendarDate): number =>
  a < b ? -1 : a > b ? 1 : 0;

export const isBefore = (a: CalendarDate, b: CalendarDate): boolean => a < b;
export const isAfter = (a: CalendarDate, b: CalendarDate): boolean => a > b;

export const isWithin = (d: CalendarDate, start: CalendarDate, end: CalendarDate): boolean =>
  d >= start && d <= end;
