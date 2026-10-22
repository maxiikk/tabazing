// The languages: Settings offers each, named in its own language; every one fills the page; Arabic and Hebrew
// turn it round (dir="rtl"), and there ← / → keep pointing where they go on screen: the next card is on the left.
import { describe, it, expect } from 'vitest';
import { waitFor, tick, key } from '../helpers/switcher.js';
import { boot, ABC, selectedTitle, byTestId, allByTestId } from '../helpers/switcher-ui.js';
import { LANGS } from '../../utils/i18n.js';
import HE from '../../dictionaries/he.json';
import EN from '../../dictionaries/en.json';

const NAMES = ['English', 'Ελληνικά', 'Deutsch', 'Italiano', 'Français', 'Español', 'Русский', 'العربية', 'עברית', 'Română'];
const BOOKS = Object.fromEntries(await Promise.all(LANGS.map(async (lang) => [lang, (await import(`../../dictionaries/${lang}.json`)).default])));

async function openSettings() {
  byTestId('settings-button').click();
  await waitFor(() => byTestId('settings'));
  await tick();
  byTestId('settings-tab-look').click();
}

describe('the language setting', () => {
  it('offers every language, each in its own language, after "Automatic"', async () => {
    await boot({ tabs: ABC() });
    await openSettings();
    byTestId('select-settings-language').click();
    const items = allByTestId('menu-item').map((x) => x.textContent);
    expect(items.slice(1)).toEqual(NAMES);
    expect(items).toHaveLength(LANGS.length + 1);
  });

  it.each(LANGS)('%s fills the page from its dictionary', async (lang) => {
    await boot({ tabs: ABC(), preferences: { lang } });
    expect(document.documentElement.lang).toBe(lang);
    expect(byTestId('new-tab-label').textContent).toBe(BOOKS[lang].newTab);
    expect(byTestId('search').placeholder).toBe(BOOKS[lang].searchPlaceholder);
    expect(document.documentElement.dir).toBe(lang === 'ar' || lang === 'he' ? 'rtl' : 'ltr');
  });

  it('choosing Hebrew turns the page right to left at once; English turns it back', async () => {
    await boot({ tabs: ABC() });
    await openSettings();
    byTestId('select-settings-language').click();
    allByTestId('menu-item').find((x) => x.textContent === 'עברית').click();
    await waitFor(() => byTestId('settings-title')?.textContent === HE.settings);
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('he');
    byTestId('select-settings-language').click();
    allByTestId('menu-item').find((x) => x.textContent === 'English').click();
    await waitFor(() => byTestId('settings-title')?.textContent === EN.settings);
    expect(document.documentElement.dir).toBe('ltr');
  });
});

describe('right to left, the arrows go where they point', () => {
  it('← is the next card, → the one before', async () => {
    await boot({ tabs: ABC(), context: { direction: 0 }, preferences: { lang: 'he' } });
    expect(selectedTitle()).toBe('Alpha');
    key('ArrowLeft');
    expect(selectedTitle()).toBe('Bravo');
    key('ArrowLeft');
    expect(selectedTitle()).toBe('Charlie');
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
  });

  it('in the big preview too', async () => {
    const switcher = await boot({ tabs: ABC(), preferences: { lang: 'ar' } });
    switcher.selectKey('t2');
    key(' ');
    key('ArrowLeft');
    expect(byTestId('big-preview-title').textContent).toBe('Charlie');
    key('ArrowRight');
    key('ArrowRight');
    expect(byTestId('big-preview-title').textContent).toBe('Alpha');
  });

  it('Ctrl+← shows the next window', async () => {
    const switcher = await boot({
      tabs: ABC(), preferences: { allWindows: true, lang: 'he' },
      beforeImport: () => { chrome._addTab({ windowId: 2, title: 'Delta', url: 'https://delta.example/' }); },
    });
    key('ArrowLeft', { ctrlKey: true });
    expect(switcher.state.scope).toBe(1);
    key('ArrowRight', { ctrlKey: true });
    key('ArrowRight', { ctrlKey: true });
    expect(switcher.state.scope).toBe(2);
  });

  it('left to right nothing changes: → is the next card', async () => {
    await boot({ tabs: ABC(), context: { direction: 0 }, preferences: { lang: 'de' } });
    key('ArrowRight');
    expect(selectedTitle()).toBe('Bravo');
  });
});

describe('dragging right to left', () => {
  const card = () => ({ getBoundingClientRect: () => ({ left: 0, right: 100, top: 0, bottom: 80, width: 100, height: 80, x: 0, y: 0 }) });

  it('a drop on a card\'s left half goes after it, on its right half before it', async () => {
    const switcher = await boot({ tabs: ABC(), preferences: { lang: 'he' } });
    expect(switcher.dropAfter(card(), { clientX: 30 })).toBe(true);
    expect(switcher.dropAfter(card(), { clientX: 70 })).toBe(false);
  });

  it('left to right: its right half goes after it, its left half before it', async () => {
    const switcher = await boot({ tabs: ABC(), preferences: { lang: 'en' } });
    expect(switcher.dropAfter(card(), { clientX: 70 })).toBe(true);
    expect(switcher.dropAfter(card(), { clientX: 30 })).toBe(false);
  });
});
