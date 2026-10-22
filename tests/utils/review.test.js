import { describe, it, expect, vi, afterEach } from 'vitest';
import { emptyReview, dayOf, reviewPrompt } from '../../utils/review.js';
import { REVIEW } from '../../utils/constants.js';

afterEach(() => { vi.useRealTimers(); vi.doUnmock('../../utils/constants.js'); vi.resetModules(); });

describe('emptyReview', () => {
  it('starts all counters at zero, since the given time', () => {
    expect(emptyReview(1234)).toEqual({ since: 1234, opens: 0, soft: 0, lastSoft: 0, asks: 0, lastAsk: 0, done: false, day: '' });
  });
  it('defaults `since` to now and returns a fresh object each call', () => {
    vi.useFakeTimers(); vi.setSystemTime(5000);
    expect(emptyReview().since).toBe(5000);
    expect(emptyReview()).not.toBe(emptyReview());
  });
});

describe('dayOf', () => {
  it('is the local calendar day without zero padding', () => {
    expect(dayOf(new Date(2026, 0, 5, 23, 59).getTime())).toBe('2026-1-5');
    expect(dayOf(new Date(2026, 11, 31, 0, 0).getTime())).toBe('2026-12-31');
  });
  it('changes at local midnight', () => {
    const midnight = new Date(2026, 5, 1).getTime();
    expect(dayOf(midnight - 1)).toBe('2026-5-31');
    expect(dayOf(midnight)).toBe('2026-6-1');
  });
  it('defaults to now', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 17, 12));
    expect(dayOf()).toBe('2026-10-17');
  });
});

describe('reviewPrompt (shipped settings)', () => {
  it('never asks while ASK_MAX is 0', () => {
    expect(REVIEW.ASK_MAX).toBe(0);
    expect(reviewPrompt({ ...emptyReview(0), opens: 1e6 }, 1e12)).toBe(null);
  });
  it('returns null for missing or finished state', () => {
    expect(reviewPrompt(null)).toBe(null);
    expect(reviewPrompt(undefined)).toBe(null);
    expect(reviewPrompt({ ...emptyReview(0), done: true }, 1e12)).toBe(null);
  });
});

// The rules themselves, with asking switched on (ASK_MAX 2).
describe('reviewPrompt (rules)', () => {
  const DAY = 24 * 3600 * 1000;
  async function load() {
    vi.resetModules();
    vi.doMock('../../utils/constants.js', () => ({ REVIEW: { ASK_AFTER_OPENS: 15, ASK_AFTER_MILLISECONDS: 3 * DAY, ASK_GAP_MILLISECONDS: 14 * DAY, ASK_MAX: 2 } }));
    return (await import('../../utils/review.js')).reviewPrompt;
  }
  const INSTALL_TIME = Date.UTC(2026, 0, 1); // a real install time (lastAsk 0 then means "never asked")
  const ready = () => ({ ...emptyReview(INSTALL_TIME), opens: 15 });
  const now = INSTALL_TIME + 3 * DAY;

  it('asks once opens and age reach the thresholds', async () => {
    const mockedPrompt = await load();
    expect(mockedPrompt(ready(), now)).toBe('ask');
  });
  it('waits for enough opens and enough time since install', async () => {
    const mockedPrompt = await load();
    expect(mockedPrompt({ ...ready(), opens: 14 }, now)).toBe(null);
    expect(mockedPrompt(ready(), now - 1)).toBe(null);
  });
  it('never on the first open of the day, or once done', async () => {
    const mockedPrompt = await load();
    expect(mockedPrompt(ready(), now, { firstToday: true })).toBe(null);
    expect(mockedPrompt({ ...ready(), done: true }, now)).toBe(null);
  });
  it('keeps the gap between asks and stops at ASK_MAX', async () => {
    const mockedPrompt = await load();
    const asked = { ...ready(), asks: 1, lastAsk: now };
    expect(mockedPrompt(asked, now + 14 * DAY - 1)).toBe(null);
    expect(mockedPrompt(asked, now + 14 * DAY)).toBe('ask');
    expect(mockedPrompt({ ...asked, asks: 2 }, now + 100 * DAY)).toBe(null);
  });
  it('defaults `now` to the current time', async () => {
    const mockedPrompt = await load();
    vi.useFakeTimers(); vi.setSystemTime(now);
    expect(mockedPrompt(ready())).toBe('ask');
    vi.setSystemTime(now - 1);
    expect(mockedPrompt(ready())).toBe(null);
  });
});
