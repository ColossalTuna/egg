/**
 * Format duration in the form of XdXhXm.
 * @param seconds - Duration to be formatted, in seconds.
 * @param trim - Whether to trim zero components (e.g. 1d0h5m to 1d5m).
 * @returns
 */
export function formatDuration(seconds: number, trim = false): string {
  if (seconds < 0) {
    return '-' + formatDuration(-seconds);
  }
  if (seconds < 60) {
    return trim ? '0m' : '0d0h0m';
  }
  if (!isFinite(seconds)) {
    return 'Forever';
  }
  if (seconds > 3_153_600_000) {
    return '>100yr';
  }
  const yy = Math.floor(seconds / 31_536_000);
  seconds -= yy * 31536000;
  const dd = Math.floor(seconds / 86400);
  seconds -= dd * 86400;
  const hh = Math.floor(seconds / 3600);
  seconds -= hh * 3600;
  const mm = Math.floor(seconds / 60);
  let s = '';
  if (yy > 0) {
    s += `${yy}y`;
  }
  if (!trim || dd > 0) {
    s += `${dd}d`;
  }
  // leave out hours/seconds for durations > 1yr
  if (!trim || yy < 1) {
    if (!trim || hh > 0) {
      s += `${hh}h`;
    }
    if (!trim || mm > 0) {
      s += `${mm}m`;
    }
  }
  return s;
}

/**
 * Parse a duration string into seconds.
 * Supports:
 * - A bare float/int (no unit suffix), interpreted as DAYS, e.g. "1.5" -> 129600
 * - Compressed unit notation: 1y2d3h4m5s (integer per segment, any subset/order of y/d/h/m/s)
 * - All whitespace is stripped before parsing (not just leading/trailing).
 *
 * @param str - The duration string to parse
 * @returns Duration in seconds, or NaN if invalid/empty
 *
 * @example
 * parseDurationDays("1.5")     // 129600 (1.5 days)
 * parseDurationDays("30")      // 2592000 (30 days)
 * parseDurationDays("12d12h")  // 1080000
 * parseDurationDays("10h 5m")  // 36300 (whitespace stripped)
 * parseDurationDays("1y35d")   // 34560000
 * parseDurationDays("bogus")   // NaN
 */
export function parseDurationDays(str: string): number {
  if (!str) return NaN;
  const cleaned = str.replace(/\s+/g, '').toLowerCase();
  if (!cleaned) return NaN;

  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    return parseFloat(cleaned) * 86400;
  }

  if (!/^(?:\d+[ydhms])+$/.test(cleaned)) {
    return NaN;
  }

  const factors: Record<string, number> = { y: 31_536_000, d: 86400, h: 3600, m: 60, s: 1 };
  let totalSeconds = 0;
  const tokenRegex = /(\d+)([ydhms])/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(cleaned)) !== null) {
    totalSeconds += parseInt(match[1], 10) * factors[match[2]];
  }
  return totalSeconds;
}

/**
 * Tolerance, in seconds, for the formatDuration/parseDurationDays round-trip
 * check in isDurationRoundTripSafe. This is a time budget for mission
 * launches spanning days, so second-level precision isn't meaningful; 1s of
 * tolerance comfortably absorbs float noise from the day-to-seconds
 * conversion in parseDurationDays while still catching normalizations that
 * would truncate away a real double-digit-second (or larger) remainder.
 */
export const DURATION_ROUNDTRIP_EPSILON_SECONDS = 1;

/**
 * True if normalizing `input` via parseDurationDays -> formatDuration ->
 * parseDurationDays round-trips back to (within
 * DURATION_ROUNDTRIP_EPSILON_SECONDS of) the original value. Used to decide
 * whether normalizing a user-typed duration is safe, i.e. doesn't silently
 * truncate a meaningful remainder.
 * @param input - The raw duration string as typed by the user.
 * @returns Whether it is safe to replace `input` with its normalized form.
 */
export function isDurationRoundTripSafe(input: string): boolean {
  const seconds = parseDurationDays(input);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return false;
  }
  const normalized = formatDuration(seconds, true);
  const reparsed = parseDurationDays(normalized);
  return Number.isFinite(reparsed) && Math.abs(reparsed - seconds) <= DURATION_ROUNDTRIP_EPSILON_SECONDS;
}
