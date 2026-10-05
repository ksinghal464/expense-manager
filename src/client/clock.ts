/**
 * Pure helpers behind the clock-dial time picker (ClockPicker.tsx), kept
 * separate so they can be unit-tested without a DOM. Values use the same
 * local "YYYY-MM-DDTHH:mm" format as a datetime-local input, so forms keep
 * storing exactly what they did before.
 */

export type Meridiem = 'AM' | 'PM';

/** Split a "YYYY-MM-DDTHH:mm" value into its date and time parts. */
export function splitDateTime(value: string): { date: string; time: string } {
  const [date = '', rest = ''] = value.split('T');
  return { date, time: rest.slice(0, 5) || '00:00' };
}

/** Join date ("YYYY-MM-DD") and time ("HH:mm") into a datetime-local value. */
export function joinDateTime(date: string, time: string): string {
  return `${date}T${time}`;
}

/** "HH:mm" (24h) -> 24h hour and minute numbers. Invalid parts become 0. */
export function parseTime(time: string): { hour: number; minute: number } {
  const [h, m] = time.split(':').map((x) => parseInt(x, 10));
  const hour = Number.isFinite(h) && h >= 0 && h < 24 ? h : 0;
  const minute = Number.isFinite(m) && m >= 0 && m < 60 ? m : 0;
  return { hour, minute };
}

/** 24h hour + minute -> "HH:mm". */
export function formatTime(hour: number, minute: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(hour)}:${p(minute)}`;
}

/** 24h hour -> 12h hour (1-12) + AM/PM. */
export function to12h(hour: number): { hour12: number; meridiem: Meridiem } {
  return { hour12: hour % 12 === 0 ? 12 : hour % 12, meridiem: hour < 12 ? 'AM' : 'PM' };
}

/** 12h hour (1-12) + AM/PM -> 24h hour. */
export function to24h(hour12: number, meridiem: Meridiem): number {
  const h = hour12 % 12;
  return meridiem === 'PM' ? h + 12 : h;
}

/** "HH:mm" -> "h:mm AM/PM" for display. */
export function displayTime(time: string): string {
  const { hour, minute } = parseTime(time);
  const { hour12, meridiem } = to12h(hour);
  return `${hour12}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

/**
 * Angle in degrees, clockwise from 12 o'clock, of a point (dx, dy) relative
 * to the dial centre (screen coordinates, so +dy is down). Range [0, 360).
 */
export function angleFromCenter(dx: number, dy: number): number {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Dial angle -> 12h hour (1-12), snapping to the nearest hour mark. */
export function hourFromAngle(angle: number): number {
  const h = Math.round(angle / 30) % 12;
  return h === 0 ? 12 : h;
}

/** Dial angle -> minute (0-59), snapping to the nearest minute (or `step` minutes). */
export function minuteFromAngle(angle: number, step = 1): number {
  const m = Math.round(angle / (6 * step)) * step;
  return m % 60;
}

/** Position on the dial (degrees clockwise from 12) of a 12h hour or a minute. */
export const hourAngle = (hour12: number): number => (hour12 % 12) * 30;
export const minuteAngle = (minute: number): number => minute * 6;
