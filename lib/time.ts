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
