import { describe, expect, it } from '@jest/globals';
import { parseDurationDays } from './time';

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
});
