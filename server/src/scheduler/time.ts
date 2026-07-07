/** Timezone helpers: convert between absolute Dates and (date, minutes) wall-clock pairs. */

function tzOffsetMinutes(utc: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(dtf.formatToParts(utc).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUtc - utc.getTime()) / 60_000;
}

/** Absolute instant -> wall-clock (YYYY-MM-DD, minutes since midnight) in tz. */
export function toWallClock(d: Date, tz: string): { date: string; minutes: number } {
  const local = new Date(d.getTime() + tzOffsetMinutes(d, tz) * 60_000);
  return {
    date: local.toISOString().slice(0, 10),
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes(),
  };
}

/** Wall-clock (YYYY-MM-DD, minutes) in tz -> absolute instant. DST-corrected. */
export function fromWallClock(date: string, minutes: number, tz: string): Date {
  const naive = new Date(`${date}T00:00:00Z`).getTime() + minutes * 60_000;
  let offset = tzOffsetMinutes(new Date(naive), tz);
  let t = naive - offset * 60_000;
  const offset2 = tzOffsetMinutes(new Date(t), tz);
  if (offset2 !== offset) t = naive - offset2 * 60_000;
  return new Date(t);
}

export function compareDay(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
