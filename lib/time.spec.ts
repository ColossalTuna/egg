import { describe, expect, it } from '@jest/globals';
import { formatDuration, isDurationNormalizable, parseDurationDays } from './time';

describe('parseDurationDays', () => {
  it('parses bare integer as days (backward compat)', () => {
    expect(parseDurationDays('30')).toBe(30 * 86400);
  });
  it('parses bare decimal as days', () => {
    expect(parseDurationDays('1.5')).toBe(1.5 * 86400);
  });
  it('parses compound d/h/m/s', () => {
    expect(parseDurationDays('12d12h')).toBe(12 * 86400 + 12 * 3600);
    expect(parseDurationDays('10h5m')).toBe(10 * 3600 + 5 * 60);
    expect(parseDurationDays('1d2h3m4s')).toBe(86400 + 2 * 3600 + 3 * 60 + 4);
  });
  it('strips all internal whitespace, not just outer', () => {
    expect(parseDurationDays('10h 5m')).toBe(10 * 3600 + 5 * 60);
    expect(parseDurationDays(' 12 d 12 h ')).toBe(12 * 86400 + 12 * 3600);
  });
  it('is case-insensitive', () => {
    expect(parseDurationDays('12D12H')).toBe(12 * 86400 + 12 * 3600);
  });
  it('returns NaN for invalid input', () => {
    expect(parseDurationDays('')).toBeNaN();
    expect(parseDurationDays('bogus')).toBeNaN();
    expect(parseDurationDays('10x')).toBeNaN();
  });
  it('returns NaN for garbage with embedded unit-like substrings', () => {
    expect(parseDurationDays('1hbogus')).toBeNaN();
    expect(parseDurationDays('bogus1h')).toBeNaN();
    expect(parseDurationDays('30dhours')).toBeNaN();
    expect(parseDurationDays('5hgarbage')).toBeNaN();
  });
  it('parses year unit', () => {
    expect(parseDurationDays('1y35d')).toBe(31_536_000 + 35 * 86400);
  });
  it('round-trips long durations through formatDuration without losing precision', () => {
    expect(parseDurationDays(formatDuration(400 * 86400, true))).toBe(400 * 86400);
  });
});

// Regression tests for isDurationNormalizable, the predicate used by
// onWaitTimeBlur in OptimizerSidebar.vue to decide whether to replace the
// user's typed text with its normalized form. It intentionally does not
// compare the normalized value against the original: for a mission-launch
// time budget spanning hours to days, no remainder formatDuration drops
// (sub-minute or otherwise) is meaningful to preserve. The only real
// rejection case is formatDuration's >100yr cutoff, which produces a
// non-numeric string. These tests exercise the real shared predicate (from
// ./time, also used by the component) rather than a local reimplementation.
describe('formatDuration/parseDurationDays round-trip (onWaitTimeBlur precision)', () => {
  it('accepts "295.6" days despite floating-point noise from the day-to-seconds conversion', () => {
    const seconds = parseDurationDays('295.6');
    // parseFloat('295.6') * 86400 introduces float noise (not exactly 25539840).
    expect(seconds).not.toBe(25539840);
    expect(seconds).toBeCloseTo(25539840, 5);
    expect(isDurationNormalizable('295.6')).toBe(true);
  });

  it('accepts "0.00069560" days despite formatDuration truncating it to whole minutes', () => {
    const seconds = parseDurationDays('0.00069560');
    expect(seconds).toBeCloseTo(60.09984, 5);
    // formatDuration truncates this to whole minutes ("1m" = 60s), losing ~0.1s.
    // Sub-minute precision was never meaningful for this time-budget field.
    expect(formatDuration(seconds, true)).toBe('1m');
    expect(isDurationNormalizable('0.00069560')).toBe(true);
  });

  it('accepts input with a significant sub-minute remainder (e.g. "2d1m45s") since it is not meaningful here', () => {
    // 2 days, 1 minute, 45 seconds expressed as a bare decimal-day input.
    const input = ((2 * 86400 + 60 + 45) / 86400).toFixed(10);
    const seconds = parseDurationDays(input);
    const normalized = formatDuration(seconds, true);
    // formatDuration drops the 45s remainder entirely (no seconds field in its output).
    expect(normalized).toBe('2d1m');
    expect(Math.abs(parseDurationDays(normalized) - seconds)).toBeCloseTo(45, 0);
    expect(isDurationNormalizable(input)).toBe(true);
  });

  it('rejects durations exceeding the >100yr cutoff instead of falling through on NaN', () => {
    const hundredOneYearsInDays = 101 * 365;
    const seconds = parseDurationDays(String(hundredOneYearsInDays));
    const normalized = formatDuration(seconds, true);
    expect(normalized).toBe('>100yr');
    // parseDurationDays('>100yr') is NaN; without an explicit isFinite guard
    // an implementation could incorrectly accept this and overwrite the
    // draft with the literal text '>100yr'.
    expect(parseDurationDays(normalized)).toBeNaN();
    expect(isDurationNormalizable(String(hundredOneYearsInDays))).toBe(false);
  });
});
