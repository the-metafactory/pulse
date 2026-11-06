function localDay(at: Date, timeZone: string | undefined): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

const isoDay = (year: number, month: number, day: number): string => new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);

/** Tells a model which day it is, since an agent step sees only its prompt. The time zone defaults to the host's. */
export function runDateLine(at: Date, timeZone?: string): string {
  const { year, month, day } = localDay(at, timeZone);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `Today is ${isoDay(year, month, day)} and yesterday was ${isoDay(year, month, day - 1)} (${zone}). Read any relative date in this task against these.\n\n`;
}
