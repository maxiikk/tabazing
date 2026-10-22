import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as C from '../../utils/constants.js';
import { setLang } from '../../utils/i18n.js';

const root = (relativePath) => resolve(process.cwd(), relativePath);
const VERSION = JSON.parse(readFileSync(root('manifest.json'), 'utf8')).version;

afterEach(() => setLang('en'));

describe('message and storage names', () => {
  it('are frozen', () => {
    for (const object of [C.MESSAGE, C.FRAME_MESSAGE, C.KEY, C.LIMITS, C.NUDGE, C.REVIEW, C.WINDOW_STATES, C.MODES, C.CLOSE_REASONS]) expect(Object.isFrozen(object)).toBe(true);
  });
  it('MSG values are unique and namespaced', () => {
    const values = Object.values(C.MESSAGE);
    expect(new Set(values).size).toBe(values.length);
    for (const message of values) expect(message).toMatch(/^tabazing:[a-z-]+$/);
  });
  it('hotkey.js repeats MSG.HOTKEY verbatim (it cannot import it)', () => {
    expect(readFileSync(root('hotkey.js'), 'utf8')).toContain(`'${C.MESSAGE.HOTKEY}'`);
  });
  it('FRAME_MSG and KEY values are unique', () => {
    for (const object of [C.FRAME_MESSAGE, C.KEY]) { const values = Object.values(object); expect(new Set(values).size).toBe(values.length); }
  });
  it('per-URL / per-tab key builders do not collide with each other or with KEY names', () => {
    expect(C.previewKey('https://a.com/')).toBe('pv:https://a.com/');
    expect(C.sharpKey('https://a.com/')).toBe('pvhd:https://a.com/');
    expect(C.tabMetaKey(42)).toBe('m:42');
    const built = [C.previewKey('x'), C.sharpKey('x'), C.tabMetaKey('x')];
    expect(new Set(built).size).toBe(3);
    for (const keyName of Object.values(C.KEY)) expect(keyName).not.toMatch(/^(pv:|pvhd:|m:)/);
  });
  it('PREVIEW_PREFIX is a WebP data URL prefix; JPEG (stored before) is still read', () => {
    expect(C.PREVIEW_PREFIX).toBe('data:image/webp;base64,');
    expect(C.PREVIEW_PREFIXES).toEqual(['data:image/webp;base64,', 'data:image/jpeg;base64,']);
  });
  it('lists the window states, modes and close reasons', () => {
    expect(C.WINDOW_STATES).toEqual(['normal', 'maximized', 'fullscreen']);
    expect(C.MODES).toEqual(['overlay', 'window']);
    expect(C.CLOSE_REASONS).toEqual(['cancel', 'switch', 'restore', 'blur']);
    expect(C.SNOOZE_ALARM).toBe('tabazing:snooze');
  });
  it('pages exist in the extension', () => {
    for (const pagePath of [C.SWITCHER_PAGE, C.SWEEP_PAGE]) expect(existsSync(root(pagePath)), pagePath).toBe(true);
  });
});

describe('limits', () => {
  it('are all positive numbers', () => {
    for (const object of [C.LIMITS, C.NUDGE]) for (const [limitName, value] of Object.entries(object)) {
      expect(Number.isFinite(value), limitName).toBe(true);
      expect(value, limitName).toBeGreaterThan(0);
    }
    for (const [fieldName, value] of Object.entries(C.REVIEW)) { expect(Number.isFinite(value), fieldName).toBe(true); expect(value, fieldName).toBeGreaterThanOrEqual(0); }
  });
  it('are consistent with each other', () => {
    const limits = C.LIMITS;
    expect(limits.SHARP_MAX).toBeGreaterThan(limits.THUMB_MAX);
    expect(limits.MAX_PREVIEW_BYTES).toBeLessThan(10 * 1024 * 1024); // storage.local's quota
    expect(limits.RECENTLY_CLOSED_SEARCH).toBeGreaterThanOrEqual(limits.RECENTLY_CLOSED);
    expect(limits.RECENTLY_CLOSED_WINDOWS).toBeLessThanOrEqual(limits.RECENTLY_CLOSED);
    expect(limits.CLOSED_PREVIEW_LOOKUP).toBeLessThanOrEqual(limits.MAX_CLOSED_LOG);
    expect(limits.SWEEP_LOAD_MILLISECONDS).toBeGreaterThan(limits.SWEEP_PAINT_MILLISECONDS);
    expect(limits.OVERLAY_WATCHDOG_MILLISECONDS).toBeGreaterThan(limits.OVERLAY_VISIBLE_MILLISECONDS);
    expect(C.NUDGE.MAX).toBeGreaterThanOrEqual(1);
    expect(C.REVIEW.ASK_GAP_MILLISECONDS).toBeGreaterThan(0);
  });
});

describe('site links', () => {
  it('point at the site', () => {
    expect(C.SITE_URL).toMatch(/^https:\/\/[^/]+$/);
    expect(new URL(C.REVIEW_URL).host).toBe('chromewebstore.google.com');
  });
  it('siteUrl carries only where, the version and the UI language', () => {
    expect(C.siteUrl('/x', 'menu')).toBe(`${C.SITE_URL}/x?from=menu&v=${VERSION}&lang=en`);
    expect(C.siteUrl('/x', 'menu', '&a=1')).toBe(`${C.SITE_URL}/x?from=menu&v=${VERSION}&lang=en&a=1`);
  });
  it('reads the language at call time', () => {
    setLang('ru');
    expect(new URL(C.siteUrl('/x', 'menu')).searchParams.get('lang')).toBe('ru');
    setLang('es');
    expect(new URL(C.siteUrl('/x', 'menu')).searchParams.get('lang')).toBe('es');
  });
});
