// The languages: Settings offers each, named in its own language; every one fills the page; Arabic and Hebrew
// turn it round (dir="rtl"), and there ← / → keep pointing where they go on screen: the next card is on the left.
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, ABC, selectedTitle, tid, tids } from './_ui.js';
import { LANGS } from '../../utils/i18n.js';
import HE from '../../dictionaries/he.json';
import EN from '../../dictionaries/en.json';

const NAMES = ['English', 'Ελληνικά', 'Deutsch', 'Italiano', 'Français', 'Español', 'Русский', 'العربية', 'עברית', 'Română'];
const BOOKS = Object.fromEntries(await Promise.all(LANGS.map(async (l) => [l, (await import(`../../dictionaries/${l}.json`)).default])));

async function openSettings() {
  tid('settings-btn').click();
  await waitFor(() => tid('settings'));
  await tick();
  tid('settings-tab-look').click();
}

describe('the language setting', () => {
  it('offers every language, each in its own language, after "Automatic"', async () => {
    await boot({ tabs: ABC() });
    await openSettings();
    tid('select-settings-language').click();
    const items = tids('menu-item').map((x) => x.textContent);
    expect(items.slice(1)).toEqual(NAMES);
    expect(items).toHaveLength(LANGS.length + 1);
  });

  it.each(LANGS)('%s fills the page from its dictionary', async (lang) => {
    await boot({ tabs: ABC(), prefs: { lang } });
    expect(document.documentElement.lang).toBe(lang);
    expect(tid('newtab-label').textContent).toBe(BOOKS[lang].newTab);
    expect(tid('search').placeholder).toBe(BOOKS[lang].searchPlaceholder);
    expect(document.documentElement.dir).toBe(lang === 'ar' || lang === 'he' ? 'rtl' : 'ltr');
  });

  it('choosing Hebrew turns the page right to left at once; English turns it back', async () => {
    await boot({ tabs: ABC() });
    await openSettings();
    tid('select-settings-language').click();
    tids('menu-item').find((x) => x.textContent === 'עברית').click();
    await waitFor(() => tid('settings-title')?.textContent === HE.settings);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('he');
    tid('select-settings-language').click();
    tids('menu-item').find((x) => x.textContent === 'English').click();
    await waitFor(() => tid('settings-title')?.textContent === EN.settings);
    expect(document.documentElement.dir).toBe('ltr');
  });
});

describe('right to left, the arrows go where they point', () => {
  it('← is the next card, → the one before', async () => {
    await boot({ tabs: ABC(), ctx: { dir: 0 }, prefs: { lang: 'he' } });
    expect(selectedTitle()).toBe('Alpha');
    key('ArrowLeft');
    expect(selectedTitle()).toBe('Bravo');
    key('ArrowLeft');
    expect(selectedTitle()).toBe('Charlie');
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
  });

  it('in the big preview too', async () => {
    const sw = await boot({ tabs: ABC(), prefs: { lang: 'ar' } });
    sw.selectKey('t2');
    key(' ');
    key('ArrowLeft');
    expect(tid('big-preview-title').textContent).toBe('Charlie');
    key('ArrowRight');
    key('ArrowRight');
    expect(tid('big-preview-title').textContent).toBe('Alpha');
  });

  it('Ctrl+← shows the next window', async () => {
    const sw = await boot({
      tabs: ABC(), prefs: { allWindows: true, lang: 'he' },
      beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); },
    });
    key('ArrowLeft', { ctrlKey: true });
    expect(sw.state.scope).toBe(1);
    key('ArrowRight', { ctrlKey: true });
    key('ArrowRight', { ctrlKey: true });
    expect(sw.state.scope).toBe(2);
  });

  it('left to right nothing changes: → is the next card', async () => {
    await boot({ tabs: ABC(), ctx: { dir: 0 }, prefs: { lang: 'de' } });
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
  });
});

describe('dragging right to left', () => {
  const card = () => ({ getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 80, width: 100, height: 80, x: 0, y: 0 }) });

  it('a drop on a card\'s left half goes after it, on its right half before it', async () => {
    const sw = await boot({ tabs: ABC(), prefs: { lang: 'he' } });
    expect(sw.dropAfter(card(), { clientX: 30 })).toBe(true);
    expect(sw.dropAfter(card(), { clientX: 70 })).toBe(false);
  });

  it('left to right: its right half goes after it, its left half before it', async () => {
    const sw = await boot({ tabs: ABC(), prefs: { lang: 'en' } });
    expect(sw.dropAfter(card(), { clientX: 70 })).toBe(true);
    expect(sw.dropAfter(card(), { clientX: 30 })).toBe(false);
  });
});
