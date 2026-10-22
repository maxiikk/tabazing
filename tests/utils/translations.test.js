// utils/translations.js: the ICU MessageFormat subset (formatMessage) and translate() over the dictionaries.
import { describe, it, expect, afterEach, vi } from 'vitest';
import EN from '../../dictionaries/en.json';
import { formatMessage, translate, setLocale, getLocale, LANGUAGES } from '../../utils/translations.js';

afterEach(() => setLocale('en'));
const format = (pattern, data, lang = 'en') => formatMessage(pattern, data, lang);

describe('formatMessage: placeholders', () => {
  it('fills named placeholders, any number of times', () => {
    expect(format('{amount} items', { amount: 2 })).toBe('2 items');
    expect(format('{a} and {b}, then {a}', { a: 'x', b: 'y' })).toBe('x and y, then x');
    expect(format('  { spaced }  ', { spaced: 1 })).toBe('  1  ');
  });
  it('leaves a placeholder with no value as it is', () => {
    expect(format('Hello {name}', {})).toBe('Hello {name}');
    expect(format('Hello {name}')).toBe('Hello {name}');
  });
  it('turns values into text (0, false and empty strings too)', () => {
    expect(format('{n}|{b}|{s}|{x}', { n: 0, b: false, s: '', x: null })).toBe('0|false||null');
  });
  it('formats {n, number} for the language', () => {
    expect(format('{n, number}', { n: 1234.5 })).toBe('1,234.5');
    expect(format('{n, number}', { n: 1234.5 }, 'es')).toBe(new Intl.NumberFormat('es').format(1234.5));
  });
  it('a plain text message comes back unchanged, apostrophes and # included', () => {
    expect(format("Don't group this window's tabs (ignoring the #part)")).toBe("Don't group this window's tabs (ignoring the #part)");
  });
});

describe('formatMessage: plural', () => {
  const tabs = '{count, plural, one {# tab} other {# tabs}}';
  it('picks the form for the count, # is the count', () => {
    expect(format(tabs, { count: 1 })).toBe('1 tab');
    expect(format(tabs, { count: 0 })).toBe('0 tabs');
    expect(format(tabs, { count: 2 })).toBe('2 tabs');
    expect(format(tabs, { count: 1500 })).toBe('1,500 tabs'); // # is formatted like a number
  });
  it('=N options win over categories', () => {
    const message = '{count, plural, =0 {no tabs} =1 {one tab} other {# tabs}}';
    expect(format(message, { count: 0 })).toBe('no tabs');
    expect(format(message, { count: 1 })).toBe('one tab');
    expect(format(message, { count: 7 })).toBe('7 tabs');
  });
  it('uses the language’s own categories: Russian one / few / many', () => {
    const message = '{count, plural, one {# вкладка} few {# вкладки} many {# вкладок} other {# вкладки}}';
    expect([1, 2, 5, 11, 21, 22, 25, 1.5].map((count) => format(message, { count }, 'ru'))).toEqual([
      '1 вкладка', '2 вкладки', '5 вкладок', '11 вкладок', '21 вкладка', '22 вкладки', '25 вкладок', '1,5 вкладки',
    ]);
  });
  it('falls back to other when the category has no option', () => {
    expect(format('{n, plural, other {# things}}', { n: 1 })).toBe('1 things');
  });
  it('mixes other placeholders into the forms', () => {
    const message = '{count, plural, one {Snoozed # tab until {time}} other {Snoozed # tabs until {time}}}';
    expect(format(message, { count: 3, time: '18:00' })).toBe('Snoozed 3 tabs until 18:00');
  });
  it('offset: counts from that much less', () => {
    const message = '{n, plural, offset:1 =0 {nobody} =1 {you} one {you and # other} other {you and # others}}';
    expect([0, 1, 2, 5].map((count) => format(message, { n: count }))).toEqual(['nobody', 'you', 'you and 1 other', 'you and 4 others']);
  });
  it('nests: a plural inside a select', () => {
    const message = '{who, select, me {{n, plural, one {I have # tab} other {I have # tabs}}} other {{who} has {n, plural, one {# tab} other {# tabs}}}}';
    expect(format(message, { who: 'me', n: 1 })).toBe('I have 1 tab');
    expect(format(message, { who: 'Ana', n: 3 })).toBe('Ana has 3 tabs');
  });
  it('a missing count leaves the placeholder', () => {
    expect(format(tabs, {})).toBe('{count}');
  });
});

describe('formatMessage: selectordinal and select', () => {
  it('selectordinal picks the ordinal form', () => {
    const message = '{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}';
    expect([1, 2, 3, 4, 11, 21, 22].map((count) => format(message, { n: count }))).toEqual(['1st', '2nd', '3rd', '4th', '11th', '21st', '22nd']);
  });
  it('select picks by value, else other', () => {
    const message = '{kind, select, tab {an open tab} mark {a bookmark} other {something}}';
    expect(format(message, { kind: 'mark' })).toBe('a bookmark');
    expect(format(message, { kind: 'x' })).toBe('something');
  });
});

describe('formatMessage: quoting and errors', () => {
  it("'' is one apostrophe; '{…}' and '#' (in a plural) are literal", () => {
    expect(format("it''s {x}", { x: 1 })).toBe("it's 1");
    expect(format("'{x}' is {x}", { x: 1 })).toBe('{x} is 1');
    expect(format("{n, plural, other {'#' # items}}", { n: 2 })).toBe('# 2 items');
  });
  it('rejects broken messages with a clear error', () => {
    expect(() => format('{x')).toThrow(SyntaxError);
    expect(() => format('a } b')).toThrow(SyntaxError);
    expect(() => format('{n, plural, one {x}}', { n: 1 })).toThrow(/other/);
    expect(() => format('{n, plural, one x}')).toThrow(SyntaxError);
  });
});

describe('t', () => {
  it('knows its languages and switches between them', () => {
    expect([...LANGUAGES].sort()).toEqual(['ar', 'de', 'el', 'en', 'es', 'fr', 'he', 'it', 'ro', 'ru']);
    expect(setLocale('ru')).toBe('ru');
    expect(getLocale()).toBe('ru');
    expect(setLocale('xx')).toBe('en');
  });
  it('a key no dictionary has comes back as the key', () => {
    expect(translate('noSuchKey_abc')).toBe('noSuchKey_abc');
  });
  it('reads the current language', () => {
    setLocale('es');
    expect(translate('newTab')).toBe('Nueva pestaña');
    setLocale('en');
    expect(translate('newTab')).toBe('New tab');
  });
});

describe('dictionaries, read when needed', () => {
  it('a page reads a dictionary only when it is needed, and once (English too: nothing is imported up front)', async () => {
    vi.resetModules();
    const fresh = await import('../../utils/translations.js');
    const RU = (await import('../../dictionaries/ru.json')).default;
    expect(fresh.LANGUAGES.filter((lang) => fresh.hasDictionary(lang))).toEqual([]);
    expect(fresh.translate('newTab')).toBe('newTab'); // nothing read yet: the key itself
    await fresh.loadDictionary('en');
    fresh.setLocale('ru');
    expect(fresh.getLocale()).toBe('ru');
    expect(fresh.translate('newTab')).toBe(EN.newTab); // in English until it is read
    await Promise.all([fresh.loadDictionary('ru'), fresh.loadDictionary('ru')]); // (read once)
    expect(fresh.translate('newTab')).toBe(RU.newTab);
    expect(fresh.LANGUAGES.filter((lang) => fresh.hasDictionary(lang))).toEqual(['en', 'ru']); // nothing else
    await fresh.loadDictionary('xx'); // unknown: nothing to read
    expect(fresh.hasDictionary('xx')).toBe(false);
  });

  it('the service worker registers just the texts it shows, in every language (utils/background-messages.js)', async () => {
    vi.resetModules();
    const fresh = await import('../../utils/translations.js');
    const messages = (await import('../../utils/background-messages.js')).default;
    const EL = (await import('../../dictionaries/el.json')).default;
    fresh.addDictionaries(messages);
    expect(fresh.LANGUAGES.every((lang) => fresh.hasDictionary(lang))).toBe(true);
    fresh.setLocale('el');
    expect(fresh.translate('flyoutTitle')).toBe(EL.flyoutTitle);
    expect(Object.keys(messages.en).length).toBeLessThan(20); // a handful of texts, not the dictionaries
  });
});
