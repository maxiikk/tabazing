import { describe, it, expect, vi, afterEach } from 'vitest';
import { LANGS, loadLang, setLang, uiLang, timeAgo, localizePage } from '../../lib/i18n.js';
import { t } from '../../lib/translations.js';
import EN from '../../dictionaries/en.json';
import RU from '../../dictionaries/ru.json';
import ES from '../../dictionaries/es.json';

afterEach(() => { setLang('en'); vi.useRealTimers(); vi.doUnmock('../../dictionaries/ru.json'); vi.resetModules(); document.body.replaceChildren(); });

describe('LANGS', () => {
  it('is the frozen list of shipped languages', () => {
    expect(LANGS).toEqual(['en', 'ru', 'es']);
    expect(Object.isFrozen(LANGS)).toBe(true);
  });
});

describe('language choice', () => {
  it('starts in Chrome\'s language, falling back to English', async () => {
    for (const [ui, want] of [['ru-RU', 'ru'], ['ES', 'es'], ['fr', 'en'], ['', 'en'], [undefined, 'en']]) {
      vi.resetModules();
      chrome.i18n.getUILanguage.mockReturnValue(ui);
      expect((await import('../../lib/i18n.js')).uiLang(), String(ui)).toBe(want);
    }
  });
  it('setLang switches right away; "auto" and unknown values follow Chrome', () => {
    expect(setLang('ru')).toBe('ru');
    expect(uiLang()).toBe('ru');
    expect(t('newTab')).toBe(RU.newTab);
    chrome._data.lang = 'es-419';
    expect(setLang('auto')).toBe('es');
    expect(setLang('de')).toBe('es');
    expect(setLang(undefined)).toBe('es');
    chrome._data.lang = 'ja';
    expect(setLang('auto')).toBe('en');
  });
  it('loadLang reads prefs.lang from storage', async () => {
    await chrome.storage.local.set({ prefs: { lang: 'es' } });
    expect(await loadLang()).toBe('es');
    expect(uiLang()).toBe('es');
  });
  it('loadLang follows Chrome for "auto", no prefs, or an invalid value', async () => {
    chrome._data.lang = 'ru';
    expect(await loadLang()).toBe('ru');
    await chrome.storage.local.set({ prefs: { lang: 'auto' } });
    expect(await loadLang()).toBe('ru');
    await chrome.storage.local.set({ prefs: { lang: 'xx' } });
    expect(await loadLang()).toBe('ru');
    await chrome.storage.local.set({ prefs: { startup: true } });
    chrome._data.lang = 'en-GB';
    expect(await loadLang()).toBe('en');
  });
  it('loadLang survives a storage error', async () => {
    chrome._data.lang = 'es';
    chrome.storage.local.get.mockRejectedValueOnce(new Error('gone'));
    expect(await loadLang()).toBe('es');
  });
});

describe('t, in the language setLang chose', () => {
  it('looks up the current language', () => {
    expect(t('newTab')).toBe('New tab');
    setLang('es');
    expect(t('newTab')).toBe(ES.newTab);
  });
  it('fills named placeholders, and leaves one without a value', () => {
    expect(t('countSearch', { open: 3, closed: 'x' })).toBe('3 open · x closed');
    expect(t('countSearch', { open: 3 })).toBe('3 open · {closed} closed');
    expect(t('newTab', { ignored: 1 })).toBe('New tab');
  });
  it('stringifies values, and does not expand placeholders inside them', () => {
    expect(t('countSearch', { open: null, closed: '{open}' })).toBe('null open · {open} closed');
  });
  it('shows the key itself when it is missing', () => {
    expect(t('no_such_key')).toBe('no_such_key');
    setLang('ru');
    expect(t('no_such_key')).toBe('no_such_key');
  });
  it('falls back to English when the language lacks a key', async () => {
    vi.resetModules();
    vi.doMock('../../dictionaries/ru.json', () => ({ default: { newTab: 'Новая' } }));
    const i18n = await import('../../lib/i18n.js');
    const { t: get } = await import('../../lib/translations.js');
    i18n.setLang('ru');
    expect(get('newTab')).toBe('Новая');
    expect(get('justNow')).toBe(EN.justNow);
  });
});

describe('plural messages', () => {
  it('pick the English form, # is the count', () => {
    expect(t('tabs', { count: 1 })).toBe('1 tab');
    expect(t('tabs', { count: 0 })).toBe('0 tabs');
    expect(t('tabs', { count: 5 })).toBe('5 tabs');
  });
  it('pick every Russian form', () => {
    setLang('ru');
    expect([1, 21, 3, 5, 11, 1.5].map((count) => t('tabs', { count }))).toEqual([
      '1 вкладка', '21 вкладка', '3 вкладки', '5 вкладок', '11 вкладок', '1,5 вкладки',
    ]);
  });
  it('take other values next to the count', () => {
    expect(t('snoozedN', { count: 2, time: 'Fri 09:00' })).toBe('Snoozed 2 tabs until Fri 09:00');
    expect(t('snoozedN', { count: 1, time: 'Fri 09:00' })).toBe('Snoozed 1 tab until Fri 09:00');
  });
  it('a language lacking the message gets English; nothing at all gives the key', async () => {
    vi.resetModules();
    vi.doMock('../../dictionaries/ru.json', () => ({ default: { onlyOther: '{count, plural, other {# x}}' } }));
    const i18n = await import('../../lib/i18n.js');
    const { t: get } = await import('../../lib/translations.js');
    i18n.setLang('ru');
    expect(get('onlyOther', { count: 1 })).toBe('1 x');
    expect(get('tabs', { count: 5 })).toBe('5 tabs');
    expect(get('nothing', { count: 3 })).toBe('nothing');
  });
});

describe('timeAgo', () => {
  const NOW = Date.UTC(2026, 9, 17, 12) / 1000;
  const rtf = (lang) => new Intl.RelativeTimeFormat(lang, { numeric: 'auto', style: 'short' });
  const at = (sec) => { vi.useFakeTimers(); vi.setSystemTime(NOW * 1000); return timeAgo(sec); };

  it('is empty without a usable timestamp', () => {
    for (const v of [0, -5, NaN, Infinity, undefined, null, '1700000000']) expect(at(v)).toBe('');
  });
  it('says "just now" under a minute, and for times in the future', () => {
    expect(at(NOW)).toBe(EN.justNow);
    expect(at(NOW - 59)).toBe(EN.justNow);
    expect(at(NOW + 3600)).toBe(EN.justNow);
  });
  it('counts minutes, hours, then days', () => {
    const f = rtf('en');
    expect(at(NOW - 60)).toBe(f.format(-1, 'minute'));
    expect(at(NOW - 89)).toBe(f.format(-1, 'minute'));
    expect(at(NOW - 90)).toBe(f.format(-2, 'minute'));
    expect(at(NOW - 3599)).toBe(f.format(-60, 'minute'));
    expect(at(NOW - 3600)).toBe(f.format(-1, 'hour'));
    expect(at(NOW - 5 * 3600)).toBe(f.format(-5, 'hour'));
    expect(at(NOW - 86400)).toBe(f.format(-1, 'day'));
    expect(at(NOW - 30 * 86400)).toBe(f.format(-30, 'day'));
  });
  it('follows the language', () => {
    setLang('ru');
    expect(at(NOW - 2 * 86400)).toBe(rtf('ru').format(-2, 'day'));
    expect(at(NOW)).toBe(RU.justNow);
  });
});

describe('localizePage', () => {
  const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
  it('fills text, title, placeholder and aria-label, and sets <html lang>', () => {
    setLang('es');
    document.body.innerHTML = `
      <span data-testid="a" data-i18n="newTab">x</span>
      <button data-testid="b" data-i18n-title="starFilterTitle" data-i18n-aria="searchAria"></button>
      <input data-testid="c" data-i18n-placeholder="searchPlaceholder">
      <span data-testid="d" data-i18n="missingKey"></span>`;
    localizePage();
    expect(document.documentElement.lang).toBe('es');
    expect(byTestId('a').textContent).toBe(ES.newTab);
    expect(byTestId('b').title).toBe(ES.starFilterTitle);
    expect(byTestId('b').getAttribute('aria-label')).toBe(ES.searchAria);
    expect(byTestId('c').placeholder).toBe(ES.searchPlaceholder);
    expect(byTestId('d').textContent).toBe('missingKey');
  });
  it('only touches the given root', () => {
    document.body.innerHTML = '<span data-testid="in" data-i18n="newTab"></span><div data-testid="root"><span data-testid="out" data-i18n="justNow"></span></div>';
    localizePage(byTestId('root'));
    expect(byTestId('out').textContent).toBe(EN.justNow);
    expect(byTestId('in').textContent).toBe('');
  });
});
