import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as C from '../../utils/constants.js';
import { setLang } from '../../utils/i18n.js';

const root = (p) => resolve(process.cwd(), p);
const VERSION = JSON.parse(readFileSync(root('manifest.json'), 'utf8')).version;

afterEach(() => setLang('en'));

describe('message and storage names', () => {
  it('are frozen', () => {
    for (const o of [C.MSG, C.FRAME_MSG, C.KEY, C.LIMITS, C.NUDGE, C.REVIEW, C.WINDOW_STATES, C.MODES, C.CLOSE_REASONS]) expect(Object.isFrozen(o)).toBe(true);
  });
  it('MSG values are unique and namespaced', () => {
    const v = Object.values(C.MSG);
    expect(new Set(v).size).toBe(v.length);
    for (const m of v) expect(m).toMatch(/^tabazing:[a-z-]+$/);
  });
  it('hotkey.js repeats MSG.HOTKEY verbatim (it cannot import it)', () => {
    expect(readFileSync(root('hotkey.js'), 'utf8')).toContain(`'${C.MSG.HOTKEY}'`);
  });
  it('FRAME_MSG and KEY values are unique', () => {
    for (const o of [C.FRAME_MSG, C.KEY]) { const v = Object.values(o); expect(new Set(v).size).toBe(v.length); }
  });
  it('per-URL / per-tab key builders do not collide with each other or with KEY names', () => {
    expect(C.previewKey('https://a.com/')).toBe('pv:https://a.com/');
    expect(C.sharpKey('https://a.com/')).toBe('pvhd:https://a.com/');
    expect(C.tabMetaKey(42)).toBe('m:42');
    const built = [C.previewKey('x'), C.sharpKey('x'), C.tabMetaKey('x')];
    expect(new Set(built).size).toBe(3);
    for (const k of Object.values(C.KEY)) expect(k).not.toMatch(/^(pv:|pvhd:|m:)/);
  });
  it('PREVIEW_PREFIX is a JPEG data URL prefix', () => {
    expect(C.PREVIEW_PREFIX).toBe('data:image/jpeg;base64,');
  });
  it('lists the window states, modes and close reasons', () => {
    expect(C.WINDOW_STATES).toEqual(['normal', 'maximized', 'fullscreen']);
    expect(C.MODES).toEqual(['overlay', 'window']);
    expect(C.CLOSE_REASONS).toEqual(['cancel', 'switch', 'restore', 'blur']);
    expect(C.SNOOZE_ALARM).toBe('tabazing:snooze');
  });
  it('pages exist in the extension', () => {
    for (const p of [C.SWITCHER_PAGE, C.SWEEP_PAGE]) expect(existsSync(root(p)), p).toBe(true);
  });
});

describe('limits', () => {
  it('are all positive numbers', () => {
    for (const o of [C.LIMITS, C.NUDGE]) for (const [k, v] of Object.entries(o)) {
      expect(Number.isFinite(v), k).toBe(true);
      expect(v, k).toBeGreaterThan(0);
    }
    for (const [k, v] of Object.entries(C.REVIEW)) { expect(Number.isFinite(v), k).toBe(true); expect(v, k).toBeGreaterThanOrEqual(0); }
  });
  it('are consistent with each other', () => {
    const L = C.LIMITS;
    expect(L.SHARP_MAX).toBeGreaterThan(L.THUMB_MAX);
    expect(L.MAX_PREVIEW_BYTES).toBeLessThan(10 * 1024 * 1024); // storage.local's quota
    expect(L.RECENTLY_CLOSED_SEARCH).toBeGreaterThanOrEqual(L.RECENTLY_CLOSED);
    expect(L.RECENTLY_CLOSED_WINDOWS).toBeLessThanOrEqual(L.RECENTLY_CLOSED);
    expect(L.CLOSED_PREVIEW_LOOKUP).toBeLessThanOrEqual(L.MAX_CLOSED_LOG);
    expect(L.SWEEP_LOAD_MS).toBeGreaterThan(L.SWEEP_PAINT_MS);
    expect(L.OVERLAY_WATCHDOG_MS).toBeGreaterThan(L.OVERLAY_VISIBLE_MS);
    expect(C.NUDGE.MAX).toBeGreaterThanOrEqual(1);
    expect(C.REVIEW.ASK_GAP_MS).toBeGreaterThan(0);
  });
});

describe('site links', () => {
  it('point at the site', () => {
    expect(C.SITE_URL).toMatch(/^https:\/\/[^/]+$/);
    expect(C.HELP_URL).toBe(C.SITE_URL + '/manual');
    expect(new URL(C.REVIEW_URL).host).toBe('chromewebstore.google.com');
  });
  it('siteUrl carries only where, the version and the UI language', () => {
    expect(C.siteUrl('/x', 'menu')).toBe(`${C.SITE_URL}/x?from=menu&v=${VERSION}&lang=en`);
    expect(C.siteUrl('/x', 'menu', '&a=1')).toBe(`${C.SITE_URL}/x?from=menu&v=${VERSION}&lang=en&a=1`);
  });
  it('reads the language at call time', () => {
    setLang('ru');
    expect(new URL(C.feedbackUrl()).searchParams.get('lang')).toBe('ru');
    setLang('es');
    expect(new URL(C.uninstallUrl()).searchParams.get('lang')).toBe('es');
  });
  it('feedbackUrl and uninstallUrl', () => {
    const f = new URL(C.feedbackUrl()), u = new URL(C.uninstallUrl());
    expect(f.origin + f.pathname).toBe(C.SITE_URL + '/feedback');
    expect(Object.fromEntries(f.searchParams)).toEqual({ from: 'extension', v: VERSION, lang: 'en' });
    expect(u.origin + u.pathname).toBe(C.SITE_URL + '/uninstall');
    expect(Object.fromEntries(u.searchParams)).toEqual({ from: 'uninstall', v: VERSION, lang: 'en' });
  });
});
